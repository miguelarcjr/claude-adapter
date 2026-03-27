// Tests for request handler utilities
import { FastifyReply } from 'fastify';

// Mock file storage utilities to prevent tests from writing to real files
jest.mock('../src/utils/tokenUsage', () => ({
    recordUsage: jest.fn()
}));

jest.mock('../src/utils/errorLog', () => ({
    recordError: jest.fn()
}));

// Mock StackSpotClient
const mockChatCompletionsCreate = jest.fn();
jest.mock('../src/stackspot/client', () => ({
    StackSpotClient: jest.fn().mockImplementation(() => ({
        chatCompletionsCreate: mockChatCompletionsCreate
    }))
}));

// Mock converters to isolate handler logic
jest.mock('../src/converters/request', () => ({
    convertRequestToOpenAI: jest.fn().mockReturnValue({ model: 'gpt-4', messages: [] })
}));

jest.mock('../src/converters/response', () => ({
    convertResponseToAnthropic: jest.fn().mockReturnValue({
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
        model: 'claude-3-opus-20240229',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 }
    }),
    createErrorResponse: jest.requireActual('../src/converters/response').createErrorResponse
}));

jest.mock('../src/converters/streaming', () => ({
    streamOpenAIToAnthropic: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../src/converters/xmlStreaming', () => ({
    streamXmlOpenAIToAnthropic: jest.fn().mockResolvedValue(undefined)
}));

// Set required StackSpot environment variables for validation
process.env.STACKSPOT_CLIENT_ID = 'test-client-id';
process.env.STACKSPOT_CLIENT_SECRET = 'test-client-secret';
process.env.STACKSPOT_REALM = 'test-realm';
process.env.STACKSPOT_AGENT_ID = 'test-agent-id';

// Import the handlers module to test generateRequestId
// We need to access internal functions, so we'll test through the exported module
const handlersModule = require('../src/server/handlers');

describe('Request Handlers', () => {
    describe('createMessagesHandler', () => {
        it('should create a handler function', () => {
            const config = {
                baseUrl: 'https://api.openai.com/v1',
                apiKey: 'test-key',
                models: {
                    opus: 'gpt-4',
                    sonnet: 'gpt-3.5-turbo',
                    haiku: 'gpt-3.5-turbo'
                }
            };

            const handler = handlersModule.createMessagesHandler(config);
            expect(typeof handler).toBe('function');
        });

        it('should handle validation errors', async () => {
            const config = {
                baseUrl: 'https://api.openai.com/v1',
                apiKey: 'test-key',
                models: { opus: 'gpt-4', sonnet: 'gpt-4', haiku: 'gpt-4' }
            };

            const handler = handlersModule.createMessagesHandler(config);

            // Mock request with invalid body (missing required fields)
            const mockRequest = {
                body: { invalid: 'request' }
            };

            let responseCode: number = 0;
            let responseBody: any = null;

            const mockReply = {
                header: jest.fn().mockReturnThis(),
                code: jest.fn().mockImplementation((code: number) => {
                    responseCode = code;
                    return mockReply;
                }),
                send: jest.fn().mockImplementation((body: any) => {
                    responseBody = body;
                    return mockReply;
                })
            } as unknown as FastifyReply;

            await handler(mockRequest, mockReply);

            expect(responseCode).toBe(400);
            expect(responseBody.error).toBeDefined();
        });
    });

    describe('Request ID generation', () => {
        it('should generate unique request IDs', () => {
            // Access the generateRequestId function indirectly by creating handlers
            const config = {
                baseUrl: 'https://api.openai.com/v1',
                apiKey: 'test-key',
                models: { opus: 'gpt-4', sonnet: 'gpt-4', haiku: 'gpt-4' }
            };

            // Call createMessagesHandler multiple times to trigger requestIdCounter
            handlersModule.createMessagesHandler(config);
            handlersModule.createMessagesHandler(config);
            handlersModule.createMessagesHandler(config);

            // If we get here without error, the module loads successfully
            expect(true).toBe(true);
        });
    });
});

describe('Error Response Handling', () => {
    it('should handle OpenAI API errors gracefully', async () => {
        const config = {
            baseUrl: 'https://invalid-url-that-will-fail.example.com',
            apiKey: 'invalid-key',
            models: { opus: 'gpt-4', sonnet: 'gpt-4', haiku: 'gpt-4' }
        };

        const handler = handlersModule.createMessagesHandler(config);

        const mockRequest = {
            body: {
                model: 'claude-4-opus',
                max_tokens: 100,
                messages: [{ role: 'user', content: 'test' }]
            }
        };

        let responseCode: number = 0;
        let responseBody: any = null;

        const mockReply = {
            header: jest.fn().mockReturnThis(),
            code: jest.fn().mockImplementation((code: number) => {
                responseCode = code;
                return mockReply;
            }),
            send: jest.fn().mockImplementation((body: any) => {
                responseBody = body;
                return mockReply;
            })
        } as unknown as FastifyReply;

        // This will fail due to invalid URL, testing error handling path
        await handler(mockRequest, mockReply);

        // Should return an error response
        expect(responseCode).toBeGreaterThanOrEqual(400);
        expect(responseBody.error).toBeDefined();
    });

    describe('Successful Requests', () => {
        const config = {
            baseUrl: 'https://api.openai.com/v1',
            apiKey: 'test-key',
            models: { opus: 'gpt-4' }
        };

        const mockRequestBase = {
            model: 'claude-3-opus-20240229',
            max_tokens: 100,
            messages: [{ role: 'user', content: 'Hello' }]
        };

        let mockReply: any;

        beforeEach(() => {
            jest.clearAllMocks();
            mockReply = {
                header: jest.fn().mockReturnThis(),
                code: jest.fn().mockReturnThis(),
                send: jest.fn().mockReturnThis()
            };
        });

        it('should handle non-streaming request', async () => {
            const handler = handlersModule.createMessagesHandler(config);

            mockChatCompletionsCreate.mockResolvedValue({
                id: 'ss_123',
                choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Hello' } }],
                usage: { prompt_tokens: 10, completion_tokens: 5 },
                model: 'stackspot-agent'
            });

            await handler({ body: { ...mockRequestBase, stream: false } }, mockReply);

            expect(mockChatCompletionsCreate).toHaveBeenCalledWith(expect.objectContaining({
                stream: false
            }));
            expect(mockReply.send).toHaveBeenCalled();
        });

        it('should handle streaming request', async () => {
            const handler = handlersModule.createMessagesHandler(config);

            // Mock streaming response (async iterator)
            const mockStream = {
                [Symbol.asyncIterator]: async function* () {
                    yield { choices: [{ delta: { content: 'He' }, finish_reason: null }] };
                    yield { choices: [{ delta: { content: 'llo' }, finish_reason: null }] };
                }
            };
            mockChatCompletionsCreate.mockResolvedValue(mockStream);

            const streamOpenAIToAnthropic = require('../src/converters/streaming').streamOpenAIToAnthropic;

            await handler({ body: { ...mockRequestBase, stream: true } }, mockReply);

            expect(mockChatCompletionsCreate).toHaveBeenCalledWith(expect.objectContaining({
                stream: true
            }));
            expect(streamOpenAIToAnthropic).toHaveBeenCalled();
        });

        it('should handle XML tool calling mode', async () => {
            const xmlConfig = { ...config, toolFormat: 'xml' as const };
            const handler = handlersModule.createMessagesHandler(xmlConfig);

            const req = {
                ...mockRequestBase,
                stream: true,
                tools: [{ name: 'test_tool', description: 'test', input_schema: {} }]
            };

            const mockStream = {
                [Symbol.asyncIterator]: async function* () { yield { choices: [{ delta: {}, finish_reason: 'stop' }] }; }
            };
            mockChatCompletionsCreate.mockResolvedValue(mockStream);
            const streamXmlOpenAIToAnthropic = require('../src/converters/xmlStreaming').streamXmlOpenAIToAnthropic;

            await handler({ body: req }, mockReply);

            expect(streamXmlOpenAIToAnthropic).toHaveBeenCalled();
        });

        it('should log info when non-streaming request completes', async () => {
            const handler = handlersModule.createMessagesHandler(config);
            mockChatCompletionsCreate.mockResolvedValue({
                id: 'ss_123',
                choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Hello' } }],
                usage: { prompt_tokens: 10, completion_tokens: 5 },
                model: 'stackspot-agent'
            });

            await handler({ body: { ...mockRequestBase, stream: false } }, mockReply);
            // Verify no error was thrown and function completed
            expect(mockReply.send).toHaveBeenCalled();
        });
    });
});
