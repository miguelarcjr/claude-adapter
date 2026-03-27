import https from 'https';
import { logger } from '../utils/logger';

export interface StackSpotConfig {
    clientId: string;
    clientSecret: string;
    realm: string;
    agentId: string;
    apiUrl?: string;
}

class ApiError extends Error {
    public status?: number;
    constructor(message: string, status?: number) {
        super(message);
        this.status = status;
    }
}

/**
 * StackSpot wraps agent responses inside `data.message` as an escaped JSON string.
 * e.g. data: {"message": "{\"summary\":\"...\",\"actions\":[]}", ...}
 * This helper parses it into a flat object with `summary` and `actions`.
 */
function unwrapStackSpotPayload(parsed: any): { text: string; actions: any[] } {
    let inner: any = parsed;

    // If there is a `message` field that is a JSON string, parse it
    if (typeof parsed.message === 'string') {
        try {
            inner = JSON.parse(parsed.message);
        } catch {
            // If it cannot be parsed, treat the raw message string as plain text
            return { text: parsed.message, actions: [] };
        }
    }

    const text = inner.summary || inner.text || '';
    const actions = Array.isArray(inner.actions) ? inner.actions : [];
    return { text, actions };
}

export class StackSpotClient {
    private config: StackSpotConfig;
    private accessToken: string | null = null;
    private tokenExpiresAt: number = 0;
    private tokenPromise?: Promise<string>;

    constructor(config: StackSpotConfig) {
        this.config = config;
    }

    private async getToken(): Promise<string> {
        if (this.accessToken && Date.now() < this.tokenExpiresAt) {
            return this.accessToken;
        }

        if (this.tokenPromise) {
            return this.tokenPromise;
        }

        this.tokenPromise = this.fetchToken().finally(() => {
            this.tokenPromise = undefined;
        });

        return this.tokenPromise;
    }

    private async fetchToken(): Promise<string> {
        const url = `https://idm.stackspot.com/${this.config.realm}/oidc/oauth/token`;
        const params = new URLSearchParams();
        params.append('client_id', this.config.clientId);
        params.append('client_secret', this.config.clientSecret);
        params.append('grant_type', 'client_credentials');

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: params.toString()
        });

        if (!response.headers.get('content-type')?.includes('json')) {
            throw new ApiError('IdP returned non-JSON response', 502);
        }

        if (!response.ok) {
            throw new ApiError(`Failed to authenticate with StackSpot: ${response.statusText}`, response.status);
        }

        const data = await response.json() as any;
        this.accessToken = data.access_token;
        // Buffer expires slightly early (e.g. 30 seconds before actual expiration)
        this.tokenExpiresAt = Date.now() + (data.expires_in - 30) * 1000;
        
        return this.accessToken!;
    }

    public async chatCompletionsCreate(request: any): Promise<any> {
        const token = await this.getToken();

        /**
         * Extracts a plain text string from an Anthropic content value.
         * Content can be: a plain string, or an array of content blocks like
         * [{type:'text', text:'...'}, {type:'tool_result', content:'...'}, ...]
         */
        function extractText(content: any): string {
            if (!content) return '';
            if (typeof content === 'string') return content;
            if (Array.isArray(content)) {
                return content.map((block: any) => {
                    if (typeof block === 'string') return block;
                    if (block.type === 'text') return block.text || '';
                    if (block.type === 'tool_result') {
                        const inner = block.content;
                        if (typeof inner === 'string') return `[Tool Result]: ${inner}`;
                        if (Array.isArray(inner)) return `[Tool Result]: ${inner.map((b: any) => b.text || '').join(' ')}`;
                        return '';
                    }
                    if (block.type === 'tool_use') {
                        return `[Tool Call: ${block.name}(${JSON.stringify(block.input || {})})]`;
                    }
                    return '';
                }).filter(Boolean).join('\n');
            }
            return String(content);
        }
        
        // Convert array of messages into a single prompt for StackSpot
        let userPrompt = '';
        if (request.messages) {
            userPrompt = request.messages.map((m: any) => {
                if (m.role === 'system') return `<system>\n${extractText(m.content)}\n</system>`;
                if (m.role === 'tool') {
                    return `TOOL RESULT (ID: ${m.tool_call_id || 'unknown'}):\n${extractText(m.content)}`;
                }
                
                let text = `${m.role.toUpperCase()}: ${extractText(m.content)}`;
                if (m.tool_calls && Array.isArray(m.tool_calls)) {
                    const toolActions = m.tool_calls.map((tc: any) => `[Action: ${tc.function?.name} with arguments ${tc.function?.arguments} (ID: ${tc.id})]`).join('\n');
                    text += '\n' + toolActions;
                }
                return text;
            }).join('\n\n');
        }


        const stackSpotBody = {
            user_prompt: userPrompt,
            streaming: request.stream || false,
            stackspot_knowledge: false,
            return_ks_in_response: true
        };
        
        const promptPreview = userPrompt.length > 200 ? userPrompt.substring(0, 200) + '...' : userPrompt;
        logger.debug('Sending payload to StackSpot API', { 
            agentId: this.config.agentId, 
            message: `Sending payload: ${promptPreview}`,
            fullMessage: `Sending full payload: ${userPrompt}`
        });

        const fetchOptions: RequestInit = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(stackSpotBody)
        };

        const baseUrl = this.config.apiUrl || 'https://genai-inference-app.stackspot.com';
        const url = `${baseUrl}/v1/agent/${this.config.agentId}/chat`;

        if (!request.stream) {
            const response = await fetch(url, fetchOptions);
            const contentType = response.headers.get('content-type');
            if (!response.ok) {
                const errBody = await response.text();
                throw new ApiError(`StackSpot API error ${response.status}: ${errBody}`, response.status);
            }
            if (!contentType?.includes('json')) {
                throw new ApiError('StackSpot returned non-JSON response', 502);
            }
            const data = (await response.json()) as any;
            
            logger.debug('StackSpot raw response received', { response: data });

            const { text: unwrappedText, actions: unwrappedActions } = unwrapStackSpotPayload(data);
            
            // Map tool calls if any
            let content = unwrappedText;
            let tool_calls = undefined;

            if (data.tool_calls && Array.isArray(data.tool_calls) && data.tool_calls.length > 0) {
                tool_calls = data.tool_calls;
            } else if (unwrappedActions.length > 0) {
                // Translator for flat "actions" strict schema from StackSpot to OpenAI format
                tool_calls = unwrappedActions.map((action: any, idx: number) => {
                    const { type, ...args } = action;
                    // Filter out null/undefined arguments to avoid validation errors in Claude
                    const filteredArgs: any = {};
                    for (const key in args) {
                        if (args[key] !== null && args[key] !== undefined) {
                            filteredArgs[key] = args[key];
                        }
                    }
                    return {
                        id: `call_${Date.now()}_${idx}`,
                        type: 'function',
                        function: {
                            name: type,
                            arguments: JSON.stringify(filteredArgs)
                        }
                    };
                });
            }

            return {
                id: `ss_${Date.now()}`,
                model: this.config.agentId,
                choices: [{
                    message: {
                        role: 'assistant',
                        content,
                        ...(tool_calls ? { tool_calls } : {})
                    },
                    finish_reason: tool_calls ? 'tool_calls' : 'stop'
                }],
                usage: {
                  prompt_tokens: 0,
                  completion_tokens: 0,
                  total_tokens: 0
                }
            };
        } else {
            // Streaming case
            const response = await fetch(url, fetchOptions);
            if (!response.ok) {
                const errBody = await response.text();
                throw new ApiError(`StackSpot API error ${response.status}: ${errBody}`, response.status);
            }
            
            async function* streamGenerator() {
                if (!response.body) return;
                
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        if (line.trim() === '') continue;
                        if (line.startsWith('data: ')) {
                            const dataStr = line.substring(6);
                            if (dataStr === '[DONE]') break;
                            
                            let parsed: any;
                            try {
                                parsed = JSON.parse(dataStr);
                            } catch (err) {
                                console.warn('Failed to parse StackSpot stream chunk as JSON:', dataStr);
                                continue;
                            }

                            // stop_reason chunk has no message, skip it
                            if (parsed.stop_reason) continue;

                            const { text: textChunk, actions: chunkActions } = unwrapStackSpotPayload(parsed);
                            let toolCalls = parsed.tool_calls;

                            if (!toolCalls && chunkActions.length > 0) {
                                toolCalls = chunkActions.map((action: any, idx: number) => {
                                    const { type, ...args } = action;
                                    // Filter out null/undefined arguments
                                    const filteredArgs: any = {};
                                    for (const key in args) {
                                        if (args[key] !== null && args[key] !== undefined) {
                                            filteredArgs[key] = args[key];
                                        }
                                    }
                                    return {
                                        id: `call_${Date.now()}_${idx}`,
                                        type: 'function',
                                        function: {
                                            name: type,
                                            arguments: JSON.stringify(filteredArgs)
                                        }
                                    };
                                });
                            }
                            
                            if (toolCalls) {
                                logger.debug('Intercepted Tool Call from StackSpot stream', { toolCalls });
                            }

                            yield {
                                id: `ss_${Date.now()}`,
                                model: 'stackspot-agent',
                                choices: [{
                                    delta: { 
                                        content: textChunk,
                                        ...(toolCalls ? { tool_calls: toolCalls } : {})
                                    },
                                    finish_reason: null
                                }]
                            };
                        }
                    }
                }
                
                yield {
                    id: `ss_${Date.now()}`,
                    model: 'stackspot-agent',
                    choices: [{
                        delta: {},
                        finish_reason: 'stop'
                    }]
                };
            }

            return streamGenerator();
        }
    }
}
