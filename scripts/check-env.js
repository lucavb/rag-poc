#!/usr/bin/env node

/**
 * Environment validation script for RAG Zendesk CLI using Zod
 */

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log(chalk.blue.bold('\n🔍 Environment Check for RAG Zendesk CLI\n'));

// Load environment variables
import dotenv from 'dotenv';
dotenv.config();

let hasErrors = false;

// Check for .env file
const envPath = path.join(process.cwd(), '.env');
if (!fs.existsSync(envPath)) {
    console.log(chalk.yellow('⚠️  .env file not found'));
    console.log(chalk.gray('   Create a .env file based on .env.example\n'));
} else {
    console.log(chalk.green('✅ .env file found\n'));
}

// Import Zod validation from the built application
let configModule;
try {
    configModule = await import('../dist/config.js');
} catch (error) {
    console.log(chalk.red('❌ Application not built yet'));
    console.log(chalk.gray('   Run "npm run build" first'));
    hasErrors = true;
}

if (configModule) {
    // Use Zod validation
    const validationResult = configModule.checkEnvironment();

    if (validationResult.isValid) {
        console.log(chalk.green('✅ All environment variables are valid\n'));

        // Show current configuration (with masked sensitive values)
        try {
            const config = configModule.getAppConfig();

            console.log(chalk.bold('Current Configuration:'));
            console.log(chalk.gray('─'.repeat(50)));

            // OpenAI settings
            console.log(chalk.blue('OpenAI:'));
            console.log(chalk.gray(`  API Key: ${config.openai.apiKey.substring(0, 8)}...`));
            console.log(chalk.gray(`  Base URL: ${config.openai.baseUrl}`));
            console.log(chalk.gray(`  Embedding Model: ${config.openai.embeddingModel}`));
            console.log(chalk.gray(`  Chat Model: ${config.openai.chatModel}`));
            console.log(chalk.gray(`  Max Tokens: ${config.openai.maxTokens}`));
            console.log(chalk.gray(`  Temperature: ${config.openai.temperature}`));

            // Zendesk settings
            console.log(chalk.blue('\nZendesk:'));
            console.log(chalk.gray(`  Subdomain: ${config.zendesk.subdomain}`));
            console.log(chalk.gray(`  Email: ${config.zendesk.email}`));
            console.log(chalk.gray(`  API Token: ${config.zendesk.apiToken.substring(0, 8)}...`));

            // Chunking settings
            console.log(chalk.blue('\nChunking:'));
            console.log(chalk.gray(`  Size: ${config.chunking.size} characters`));
            console.log(chalk.gray(`  Overlap: ${config.chunking.overlap} characters`));
            console.log(chalk.gray(`  Preserve Words: ${config.chunking.preserveWords}`));
            console.log(chalk.gray(`  Preserve Sentences: ${config.chunking.preserveSentences}`));

            // Storage settings
            console.log(chalk.blue('\nStorage:'));
            console.log(chalk.gray(`  Vector Store: ${config.vectorStore.filePath}`));
            console.log(chalk.gray(`  Chat History: ${config.chat.historyPath}`));
            console.log(chalk.gray(`  Max Context Messages: ${config.chat.maxContextMessages}`));
            console.log(chalk.gray(`  Max Source Results: ${config.chat.maxSourceResults}`));
        } catch (error) {
            console.log(chalk.yellow('⚠️  Could not load configuration details'));
        }
    } else {
        console.log(chalk.red('❌ Environment validation failed:\n'));

        validationResult.errors.forEach((error) => {
            console.log(chalk.red(`   ${error}`));
        });

        hasErrors = true;
    }
}

console.log();

// Check data directory
const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
    console.log(chalk.yellow('⚠️  Data directory not found - will be created on first run'));
} else {
    console.log(chalk.green('✅ Data directory exists'));
}

// Check if built
const distDir = path.join(process.cwd(), 'dist');
if (!fs.existsSync(distDir)) {
    console.log(chalk.red('❌ Project not built - run "npm run build" first'));
    hasErrors = true;
} else {
    console.log(chalk.green('✅ Project built successfully'));
}

console.log();

// Final status
if (hasErrors) {
    console.log(chalk.red.bold('❌ Environment check failed'));
    console.log(chalk.gray('Please fix the issues above before running the CLI\n'));

    console.log(chalk.bold('Next steps:'));
    console.log(chalk.gray('1. Copy .env.example to .env'));
    console.log(chalk.gray('2. Fill in your API credentials in .env'));
    console.log(chalk.gray('3. Run "npm run build"'));
    console.log(chalk.gray('4. Run "npm start" to start the CLI\n'));

    process.exit(1);
} else {
    console.log(chalk.green.bold('✅ Environment check passed'));
    console.log(chalk.gray('You can now run the CLI with "npm start"\n'));

    if (!fs.existsSync(path.join(dataDir, 'vector-store.json'))) {
        console.log(
            chalk.blue('💡 Tip: Run "reindex" command on first launch to fetch and index your Zendesk articles\n'),
        );
    }
}
