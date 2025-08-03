#!/usr/bin/env node

/**
 * RAG Zendesk CLI - A proof of concept for RAG implementation with Zendesk
 * Copyright (C) 2025 Luca Becker <hello@luca-becker.me>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * Main CLI orchestrator for RAG Zendesk application
 */

import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import { ZendeskOAuthClient } from './zendesk-oauth.ts';
import { EmbeddingService } from './embeddings.ts';
import { VectorStoreService } from './vectorstore.ts';
import { ChatService } from './chat.ts';
import { getAppConfig } from './config.ts';
import type { AppConfig, Logger, LogLevel, CliCommand } from './types.ts';

class ConsoleLogger implements Logger {
    private level: LogLevel = 'info';

    setLevel(level: LogLevel): void {
        this.level = level;
    }

    debug(message: string, ...args: unknown[]): void {
        if (this.shouldLog('debug')) {
            console.log(chalk.gray(`[DEBUG] ${message}`), ...args);
        }
    }

    info(message: string, ...args: unknown[]): void {
        if (this.shouldLog('info')) {
            console.log(chalk.blue(`[INFO] ${message}`), ...args);
        }
    }

    warn(message: string, ...args: unknown[]): void {
        if (this.shouldLog('warn')) {
            console.log(chalk.yellow(`[WARN] ${message}`), ...args);
        }
    }

    error(message: string, ...args: unknown[]): void {
        if (this.shouldLog('error')) {
            console.log(chalk.red(`[ERROR] ${message}`), ...args);
        }
    }

    private shouldLog(level: LogLevel): boolean {
        const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
        const currentIndex = levels.indexOf(this.level);
        const messageIndex = levels.indexOf(level);
        return messageIndex >= currentIndex;
    }
}

class RAGZendeskCLI {
    private config: AppConfig;
    private logger: ConsoleLogger;
    private zendeskClient: ZendeskOAuthClient;
    private embeddingService: EmbeddingService;
    private vectorStore: VectorStoreService;
    private chatService: ChatService;
    private isInitialized: boolean = false;

    constructor() {
        this.logger = new ConsoleLogger();

        try {
            this.config = getAppConfig();
            this.logger.setLevel(this.config.logLevel);
        } catch {
            // Error already logged by validateEnvironment
            process.exit(1);
        }

        // Initialize services with OAuth authentication only
        this.zendeskClient = new ZendeskOAuthClient(
            {
                subdomain: this.config.zendesk.subdomain,
                accessToken: this.config.zendesk.oauthToken,
            },
            this.config.timeouts.apiRequestMs,
            this.logger,
        );
        this.logger.info('Using Zendesk OAuth authentication');

        this.embeddingService = new EmbeddingService(
            this.config.tngEmbedding,
            this.config.timeouts.apiRequestMs,
            this.logger,
        );
        this.vectorStore = new VectorStoreService(this.config.vectorStore.filePath, this.logger);
        this.chatService = new ChatService(this.config, this.logger);
    }

    /**
     * Main entry point
     */
    async run(): Promise<void> {
        try {
            // Show welcome message
            this.showWelcome();

            // Initialize system
            await this.initialize();

            // Start interactive CLI
            await this.startInteractiveCLI();
        } catch (error) {
            this.logger.error('Application error:', error);
            process.exit(1);
        }
    }

    /**
     * Initialize the system
     */
    private async initialize(): Promise<void> {
        if (this.isInitialized) {
            return;
        }

        const spinner = ora('Initializing RAG system...').start();

        try {
            // Test Zendesk connection
            spinner.text = 'Testing Zendesk connection...';
            const zendeskConnected = await this.zendeskClient.testConnection();
            if (!zendeskConnected) {
                throw new Error('Failed to connect to Zendesk API');
            }

            // Load vector store
            spinner.text = 'Loading vector store...';
            await this.vectorStore.load();

            // Load chat session
            spinner.text = 'Loading chat session...';
            await this.chatService.loadOrCreateSession();

            spinner.succeed('System initialized successfully');
            this.isInitialized = true;
        } catch (error) {
            spinner.fail('System initialization failed');
            throw error;
        }
    }

    /**
     * Start interactive CLI
     */
    private async startInteractiveCLI(): Promise<void> {
        const commands: CliCommand[] = [
            {
                name: 'chat',
                description: 'Start chatting with the AI assistant',
                handler: () => this.startChatMode(),
            },
            {
                name: 'reindex',
                description: 'Reindex Zendesk articles and rebuild embeddings',
                handler: () => this.reindexArticles(),
            },
            {
                name: 'clear',
                description: 'Clear chat history',
                handler: () => this.clearChatHistory(),
            },
            {
                name: 'stats',
                description: 'Show system statistics',
                handler: () => this.showStats(),
            },
            {
                name: 'exit',
                description: 'Exit the application',
                handler: () => this.exit(),
            },
        ];

        while (true) {
            try {
                console.log(); // Add spacing

                const { command } = await inquirer.prompt([
                    {
                        type: 'list',
                        name: 'command',
                        message: 'What would you like to do?',
                        choices: commands.map((cmd) => ({
                            name: `${cmd.name} - ${cmd.description}`,
                            value: cmd.name,
                        })),
                    },
                ]);

                const selectedCommand = commands.find((cmd) => cmd.name === command);
                if (selectedCommand) {
                    await selectedCommand.handler();
                }

                if (command === 'exit') {
                    break;
                }
            } catch (error) {
                if (error instanceof Error && error.message.includes('User force closed')) {
                    console.log('\nGoodbye!');
                    break;
                }
                this.logger.error('Command error:', error);
            }
        }
    }

    /**
     * Start chat mode
     */
    private async startChatMode(): Promise<void> {
        console.log(chalk.green('\n🤖 Chat mode started! Type your questions below.'));
        console.log(
            chalk.gray('Tips: Ask questions about your Zendesk articles. Type "exit" to return to main menu.\n'),
        );

        while (true) {
            try {
                const { message } = await inquirer.prompt([
                    {
                        type: 'input',
                        name: 'message',
                        message: chalk.cyan('You:'),
                        validate: (input: string) => {
                            return input.trim().length > 0 || 'Please enter a message';
                        },
                    },
                ]);

                if (message.toLowerCase().trim() === 'exit') {
                    console.log(chalk.yellow('Returning to main menu...\n'));
                    break;
                }

                await this.handleChatMessage(message);
            } catch (error) {
                if (error instanceof Error && error.message.includes('User force closed')) {
                    console.log(chalk.yellow('\nReturning to main menu...\n'));
                    break;
                }
                this.logger.error('Chat error:', error);
            }
        }
    }

    /**
     * Handle a chat message
     */
    private async handleChatMessage(message: string): Promise<void> {
        const spinner = ora('Searching knowledge base...').start();

        try {
            // Create query embedding
            spinner.text = 'Creating query embedding...';
            const queryEmbedding = await this.embeddingService.createQueryEmbedding(message);

            // Search for relevant chunks
            spinner.text = 'Searching for relevant information...';
            const searchResults = await this.vectorStore.search(queryEmbedding, {
                maxResults: this.config.chat.maxSourceResults,
                minSimilarity: this.config.chat.minSimilarity,
                includeMetadata: true,
                boostRecent: true,
                recentBoostFactor: 1.1,
            });

            // Generate response
            spinner.text = 'Generating response...';
            const { response, sources } = await this.chatService.generateResponse(message, searchResults);

            spinner.stop();

            // Display response
            console.log(chalk.green('\nAssistant:'), response);

            // Display sources if any
            if (sources.length > 0) {
                console.log(chalk.gray('\nSources:'));
                sources.forEach((source, index) => {
                    console.log(
                        chalk.gray(`${index + 1}. ${source.title} (${source.relevanceScore.toFixed(2)} relevance)`),
                    );
                    console.log(chalk.gray(`   ${source.url}`));
                    console.log(chalk.gray(`   "${source.snippet}"`));
                });
            }

            console.log(); // Add spacing
        } catch (error) {
            spinner.fail('Failed to process message');
            this.logger.error('Failed to handle chat message:', error);
        }
    }

    /**
     * Reindex articles
     */
    private async reindexArticles(): Promise<void> {
        const { confirm } = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'confirm',
                message: 'This will fetch all articles from Zendesk and rebuild embeddings. Continue?',
                default: false,
            },
        ]);

        if (!confirm) {
            return;
        }

        // Show helpful tip about logging
        if (this.config.logLevel !== 'debug') {
            this.logger.info('💡 For more detailed progress info, set LOG_LEVEL=debug in your .env file');
        }

        const spinner = ora('Fetching articles from Zendesk...').start();

        try {
            const reindexStartTime = Date.now();

            // Fetch articles from Zendesk
            this.logger.info('📥 Fetching articles from Zendesk...');
            const fetchStartTime = Date.now();
            const articles = await this.zendeskClient.fetchAllArticles();
            const fetchTime = Date.now() - fetchStartTime;
            this.logger.info(`✅ Fetched ${articles.length} articles in ${Math.round(fetchTime / 1000)}s`);

            // Filter out excluded articles
            let filteredArticles = articles;
            if (this.config.excludedArticleIds.length > 0) {
                const originalCount = articles.length;
                filteredArticles = articles.filter(
                    (article) => !this.config.excludedArticleIds.includes(article.id.toString()),
                );
                const excludedCount = originalCount - filteredArticles.length;
                if (excludedCount > 0) {
                    this.logger.warn(
                        `⚠️  Excluded ${excludedCount} problematic articles: ${this.config.excludedArticleIds.join(', ')}`,
                    );
                }
            }

            // Convert HTML to text
            this.logger.info('🔄 Converting HTML content to plain text...');
            const convertStartTime = Date.now();
            const processedArticles = filteredArticles.map((article, index) => {
                if ((index + 1) % 20 === 0) {
                    this.logger.debug(`  Converted ${index + 1}/${filteredArticles.length} articles...`);
                }
                return {
                    ...article,
                    body: this.zendeskClient.htmlToText(article.body),
                };
            });
            const convertTime = Date.now() - convertStartTime;
            this.logger.info(`✅ HTML conversion completed in ${Math.round(convertTime / 1000)}s`);

            // Check if reindexing is needed
            this.logger.info('🔍 Checking which articles need reindexing...');
            const { needsReindex, newArticles, updatedArticles } = this.vectorStore.needsReindexing(processedArticles);

            if (!needsReindex) {
                spinner.succeed('✅ No reindexing needed - all articles are up to date');
                return;
            }

            const articlesToProcess = [...newArticles, ...updatedArticles];
            this.logger.info(
                `📋 Found ${newArticles.length} new articles and ${updatedArticles.length} updated articles`,
            );
            this.logger.info(`🚀 Processing ${articlesToProcess.length} articles total...`);

            // Stop the spinner and let detailed logging take over
            spinner.stop();

            // Process articles into chunks and embeddings
            const processStartTime = Date.now();
            const { chunks, embeddings } = await this.embeddingService.processArticles(
                articlesToProcess,
                this.config.chunking,
            );
            const processTime = Date.now() - processStartTime;
            this.logger.info(`✅ Processing completed in ${Math.round(processTime / 1000)}s`);
            this.logger.info(`📊 Created ${chunks.length} chunks and ${embeddings.length} embeddings`);

            // Store in vector store
            this.logger.info('💾 Updating vector store...');
            const storeStartTime = Date.now();
            await this.vectorStore.upsertData(
                articlesToProcess,
                chunks,
                embeddings,
                this.config.tngEmbedding.embeddingModel,
                this.config.chunking.size,
                this.config.chunking.overlap,
            );
            const storeTime = Date.now() - storeStartTime;

            const totalTime = Date.now() - reindexStartTime;
            this.logger.info(`✅ Vector store updated in ${Math.round(storeTime / 1000)}s`);
            this.logger.info(`🎉 Reindexing completed successfully in ${Math.round(totalTime / 1000)}s total`);
            this.logger.info(
                `📈 Processed ${articlesToProcess.length} articles → ${chunks.length} chunks → ${embeddings.length} embeddings`,
            );
        } catch (error) {
            spinner.fail('Reindexing failed');
            this.logger.error('Reindexing error:', error);
        }
    }

    /**
     * Clear chat history
     */
    private async clearChatHistory(): Promise<void> {
        const { confirm } = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'confirm',
                message: 'Are you sure you want to clear all chat history?',
                default: false,
            },
        ]);

        if (confirm) {
            await this.chatService.clearHistory();
            console.log(chalk.green('Chat history cleared successfully'));
        }
    }

    /**
     * Show system statistics
     */
    private async showStats(): Promise<void> {
        const stats = this.vectorStore.getStats();

        console.log(chalk.blue('\n📊 System Statistics:'));
        console.log(chalk.gray('─'.repeat(40)));
        console.log(`Articles indexed: ${chalk.yellow(stats.totalArticles)}`);
        console.log(`Text chunks: ${chalk.yellow(stats.totalChunks)}`);
        console.log(`Embeddings: ${chalk.yellow(stats.totalEmbeddings)}`);
        console.log(`Embedding model: ${chalk.yellow(stats.embeddingModel)}`);
        console.log(`Last updated: ${chalk.yellow(new Date(stats.lastUpdated).toLocaleString())}`);

        const chatHistory = this.chatService.getConversationHistory();
        console.log(`Chat messages: ${chalk.yellow(chatHistory.length)}`);
        console.log();
    }

    /**
     * Exit application
     */
    private async exit(): Promise<void> {
        console.log(chalk.green('Thanks for using RAG Zendesk CLI! 👋'));
        process.exit(0);
    }

    /**
     * Show welcome message
     */
    private showWelcome(): void {
        console.log(chalk.blue.bold('\n🚀 RAG Zendesk CLI'));
        console.log(chalk.gray('Chat with your Zendesk articles using AI'));
        console.log(chalk.gray('─'.repeat(50)));
    }
}

// Run the CLI application
const cli = new RAGZendeskCLI();
cli.run().catch((error) => {
    console.error(chalk.red('Fatal error:'), error);
    process.exit(1);
});
