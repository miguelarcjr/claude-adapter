import https from 'https';

export interface StackSpotConfig {
    clientId: string;
    clientSecret: string;
    realm: string;
    agentId: string;
}

export class StackSpotClient {
    private config: StackSpotConfig;
    private accessToken: string | null = null;
    private tokenExpiresAt: number = 0;

    constructor(config: StackSpotConfig) {
        this.config = config;
    }

    private async getToken(): Promise<string> {
        if (this.accessToken && Date.now() < this.tokenExpiresAt) {
            return this.accessToken;
        }

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

        if (!response.ok) {
            throw new Error(`Failed to authenticate with StackSpot: ${response.statusText}`);
        }

        const data = await response.json() as any;
        this.accessToken = data.access_token;
        // Buffer expires slightly early (e.g. 30 seconds before actual expiration)
        this.tokenExpiresAt = Date.now() + (data.expires_in - 30) * 1000;
        
        return this.accessToken!;
    }

    public async chatCompletionsCreate(request: any): Promise<any> {
        const token = await this.getToken();
        
        // Convert array of messages into a single prompt for StackSpot
        let userPrompt = '';
        if (request.messages) {
            userPrompt = request.messages.map((m: any) => {
                if (m.role === 'system') return `<system>\n${m.content}\n</system>`;
                return `${m.role.toUpperCase()}: ${m.content}`;
            }).join('\n\n');
        }

        const stackSpotBody = {
            user_prompt: userPrompt,
            stream: request.stream || false
        };

        const fetchOptions: RequestInit = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(stackSpotBody)
        };

        const baseUrl = 'https://genai-code-buddy-api.stackspot.com';
        const url = `${baseUrl}/v1/agent/${this.config.agentId}/chat`;

        if (!request.stream) {
            const response = await fetch(url, fetchOptions);
            if (!response.ok) {
                const errBody = await response.text();
                throw new Error(`StackSpot API error ${response.status}: ${errBody}`);
            }
            const data = await response.text();
            
            // Mock an OpenAI-like response object for compatibility with adapter
            return {
                id: `ss_${Date.now()}`,
                model: this.config.agentId,
                choices: [{
                    message: {
                        role: 'assistant',
                        content: data
                    },
                    finish_reason: 'stop'
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
                throw new Error(`StackSpot API error ${response.status}: ${errBody}`);
            }
            
            // We need to return an AsyncIterable that mimics OpenAI stream chunks
            // since handlers.ts expects an OpenAI Stream.
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
                    buffer = lines.pop() || ''; // keep the incomplete line in buffer

                    for (const line of lines) {
                        if (line.trim() === '') continue;
                        if (line.startsWith('data: ')) {
                            const dataStr = line.substring(6);
                            if (dataStr === '[DONE]') break;
                            
                            // StackSpot stream gives parts of text
                            // In real scenarios you should parse JSON if stackspot sends JSON
                            // Assuming StackSpot sends raw text chunks in the data (or JSON with text)
                            let textChunk = '';
                            try {
                                const parsed = JSON.parse(dataStr);
                                textChunk = parsed.text || parsed.content || '';
                            } catch {
                                textChunk = dataStr;
                            }

                            // Yield OpenAI compatible chunk
                            yield {
                                id: `ss_${Date.now()}`,
                                model: 'stackspot-agent',
                                choices: [{
                                    delta: { content: textChunk },
                                    finish_reason: null
                                }]
                            };
                        }
                    }
                }
                
                // Final chunk with finish_reason
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
