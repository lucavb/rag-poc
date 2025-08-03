/**
 * Configuration validation and loading using Zod schemas
 */

import { z } from 'zod';
import * as dotenv from 'dotenv';
import type { AppConfig } from './types.ts';

// Load environment variables
dotenv.config();

// Zod schema for environment variables
const envSchema = z.object({
    // Required TNG Embedding Server configuration
    TNG_EMBEDDING_API_KEY: z.string().min(1, 'TNG Embedding API key is required'),
    TNG_EMBEDDING_BASE_URL: z.string().url('TNG Embedding base URL must be a valid URL'),

    // Required OpenAI configuration for chat
    OPENAI_API_KEY: z.string().min(1, 'OpenAI API key is required'),
    OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),

    // Required Zendesk configuration
    ZENDESK_SUBDOMAIN: z.string().min(1, 'Zendesk subdomain is required'),

    // Zendesk authentication - either API token OR OAuth token
    ZENDESK_EMAIL: z.string().email('Zendesk email must be a valid email address').optional(),
    ZENDESK_API_TOKEN: z.string().min(1, 'Zendesk API token is required').optional(),
    ZENDESK_OAUTH_TOKEN: z.string().min(1, 'Zendesk OAuth access token is required').optional(),

    // Embedding configuration
    EMBEDDING_MODEL: z.string().default('BAAI/bge-large-en-v1.5'),

    // Chat configuration
    CHAT_MODEL: z.string().default('gpt-4'),
    MAX_TOKENS: z.coerce.number().int().min(1).max(32000).default(4000),
    TEMPERATURE: z.coerce.number().min(0).max(2).default(0.7),

    // Optional chunking configuration
    CHUNK_SIZE: z.coerce.number().int().min(100).max(8000).default(1000),
    CHUNK_OVERLAP: z.coerce.number().int().min(0).max(500).default(200), // Reduced max overlap to prevent issues

    // Optional file paths
    VECTOR_STORE_PATH: z.string().default('./data/vector-store.json'),
    CHAT_HISTORY_PATH: z.string().default('./data/chat-history.json'),

    // Optional behavior configuration
    MAX_CONTEXT_MESSAGES: z.coerce.number().int().min(1).max(50).default(10),
    MAX_SOURCE_RESULTS: z.coerce.number().int().min(1).max(20).default(5),
    MIN_SIMILARITY: z.coerce.number().min(0).max(1).default(0.7),

    // Optional logging
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

    // Optional timeout configuration
    API_TIMEOUT_MS: z.coerce.number().int().min(5000).max(120000).default(30000),

    // Optional article exclusions (comma-separated list of article IDs to skip)
    EXCLUDED_ARTICLE_IDS: z.string().default(''),
});

// Type for validated environment variables
export type ValidatedEnv = z.infer<typeof envSchema>;

// Validate environment variables
export function validateEnvironment(): ValidatedEnv {
    try {
        return envSchema.parse(process.env);
    } catch (error) {
        if (error instanceof z.ZodError) {
            console.error('❌ Environment validation failed:');
            console.error('');

            error.errors.forEach((err) => {
                const field = err.path.join('.');
                const message = err.message;
                console.error(`   ${field}: ${message}`);
            });

            console.error('');
            console.error('Please check your .env file and ensure all required variables are set.');
            console.error('You can copy .env.example to .env and fill in your values.');

            process.exit(1);
        }
        throw error;
    }
}

// Convert validated environment to AppConfig
export function createAppConfig(env: ValidatedEnv): AppConfig {
    // Validate chunk overlap is not greater than chunk size
    if (env.CHUNK_OVERLAP >= env.CHUNK_SIZE) {
        throw new Error('CHUNK_OVERLAP must be less than CHUNK_SIZE');
    }

    // Validate Zendesk authentication - must have either API token OR OAuth token
    const hasApiAuth = env.ZENDESK_EMAIL && env.ZENDESK_API_TOKEN;
    const hasOAuthAuth = env.ZENDESK_OAUTH_TOKEN;

    if (!hasApiAuth && !hasOAuthAuth) {
        throw new Error('Must provide either (ZENDESK_EMAIL + ZENDESK_API_TOKEN) or ZENDESK_OAUTH_TOKEN');
    }

    if (hasApiAuth && hasOAuthAuth) {
        throw new Error('Cannot use both API token and OAuth token authentication. Choose one.');
    }

    return {
        tngEmbedding: {
            apiKey: env.TNG_EMBEDDING_API_KEY,
            baseUrl: env.TNG_EMBEDDING_BASE_URL,
            embeddingModel: env.EMBEDDING_MODEL,
        },
        openai: {
            apiKey: env.OPENAI_API_KEY,
            baseUrl: env.OPENAI_BASE_URL,
            chatModel: env.CHAT_MODEL,
            maxTokens: env.MAX_TOKENS,
            temperature: env.TEMPERATURE,
        },
        zendesk: {
            subdomain: env.ZENDESK_SUBDOMAIN,
            email: env.ZENDESK_EMAIL || '',
            apiToken: env.ZENDESK_API_TOKEN || '',
            oauthToken: env.ZENDESK_OAUTH_TOKEN || '',
        },
        chunking: {
            size: env.CHUNK_SIZE,
            overlap: env.CHUNK_OVERLAP,
            preserveWords: true,
            preserveSentences: true,
        },
        vectorStore: {
            filePath: env.VECTOR_STORE_PATH,
        },
        chat: {
            historyPath: env.CHAT_HISTORY_PATH,
            maxContextMessages: env.MAX_CONTEXT_MESSAGES,
            maxSourceResults: env.MAX_SOURCE_RESULTS,
            minSimilarity: env.MIN_SIMILARITY,
        },
        rateLimit: {
            zendesk: {
                requestsPerMinute: 200,
                requestsPerHour: 700,
            },
            tngEmbedding: {
                requestsPerMinute: 100, // Conservative estimate, adjust based on TNG server limits
                tokensPerMinute: 50000, // Conservative estimate, adjust based on TNG server limits
            },
            openai: {
                requestsPerMinute: 500,
                tokensPerMinute: 150000,
            },
        },
        timeouts: {
            apiRequestMs: env.API_TIMEOUT_MS,
        },
        logLevel: env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error',
        excludedArticleIds: env.EXCLUDED_ARTICLE_IDS.split(',')
            .map((id) => id.trim())
            .filter((id) => id.length > 0),
    };
}

// Get validated configuration
export function getAppConfig(): AppConfig {
    const env = validateEnvironment();
    return createAppConfig(env);
}

// Get schema for documentation/validation purposes
export function getEnvSchema() {
    return envSchema;
}

// Check if environment is valid without throwing
export function checkEnvironment(): { isValid: boolean; errors: string[] } {
    try {
        validateEnvironment();
        return { isValid: true, errors: [] };
    } catch (error) {
        if (error instanceof z.ZodError) {
            const errors = error.errors.map((err) => {
                const field = err.path.join('.');
                return `${field}: ${err.message}`;
            });
            return { isValid: false, errors };
        }
        return { isValid: false, errors: [error instanceof Error ? error.message : 'Unknown error'] };
    }
}
