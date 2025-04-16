// blockchain-collector/collector.js
require('dotenv').config();
const cron = require('node-cron');
const mongoose = require('mongoose');
const axios = require('axios');
const db = require('../shared/config/db');
const { ethers } = require('ethers');
const logger = require('../shared/utils/logger');
const fs = require('fs').promises;
const path = require('path');

// Wrap everything in an async IIFE (Immediately Invoked Function Expression)
(async function() {
  try {
    // Connect to database FIRST, before importing any models
    await db.connectToDatabase();
    
    // Only import models AFTER connection is established
    const Token = require('../shared/models/Token');
    const tokenStorageService = require('./services/tokenStorageService');
    const poolService = require('./services/poolService');
    
    // Set service name for logging
    process.env.SERVICE_NAME = 'blockchain-collector';
    
    // Define the factory address
    const FACTORY_ADDRESS = '0x9bd7dCc13c532F37F65B0bF078C8f83E037e7445';
    
    // Define the TokenCreated event signature
    const TOKEN_CREATED_EVENT = 'TokenCreated(address,uint256,address,string,string,uint256,address,uint256)';

    // Define the KOA factory interface for decoding
    const koaFactoryInterface = new ethers.Interface([
      "function deployToken(string _name, string _symbol, uint256 _supply, int24 _initialTick, uint24 _fee, bytes32 _salt, address _deployer, address _recipient, uint256 _recipientAmount) payable returns (address tokenAddress, uint256 tokenId)"
    ]);
    
    // State file path
    const STATE_FILE = path.join(__dirname, '../../state/blockState.json');

    // Rate limiting configuration
    const RATE_LIMIT = {
      initialDelay: 1000, // 1 second
      maxDelay: 30000,    // 30 seconds
      backoffFactor: 1.5  // Exponential backoff factor
    };

    // Batch processing configuration
    const BATCH_CONFIG = {
      maxBatchSize: 50,    // Maximum tokens to process in one batch
      minBatchSize: 10,    // Minimum tokens to process in one batch
      batchTimeout: 5000   // 5 seconds timeout for batch processing
    };

    // Map of known transaction hashes to their correct deployer addresses
    const KNOWN_DEPLOYERS = {
      '0xd45006335d15893457b4cf57bd2528f26432c99ac3b8b086a27ac99bff5bf385': '0x86e8d2532D531ECEBa1316f5E545C8AF7B650146',
      '0x27257bcbb52cff88ac7272cfa53fafad83a141d1778593ebb74e2ecbf159cc53': '0xCA5799410f108E44Ca5fb1FF38f96c3aC5926Fac',
      '0x26ba12be030c1ad051d20a97df802661236f98b4c1117c39b9ed05506a354aa2': '0xe5351fbA63916F69A9f4A437d5BB5E2da5a0672f',
      '0xd1392dd1936c7841588a11a65cb252c5dddd9ede0a010727da38b2a154254d09': '0x01eEbDB7F6855f1DdFD38C1131d67E8Ed462eC5E'
    };

    // Addresses to exclude as deployers (even if found in transaction data)
    const EXCLUDED_DEPLOYERS = [
      '0x903878B49BBA6c55d14857fBc25805De7825e231'.toLowerCase(),
      '0x0000000000000000000000000000000000000000'.toLowerCase()
    ];

    // Function to check if an address should be excluded as a deployer
    function shouldExcludeAddress(address) {
      if (!address) return true;
      
      const normalizedAddress = address.toLowerCase();
      return EXCLUDED_DEPLOYERS.includes(normalizedAddress);
    }

    async function getDeployerFromTransaction(txHash, provider) {
      try {
        // Check cache first
        if (!global.deployerCache) {
          global.deployerCache = new Map();
        }
        
        if (global.deployerCache.has(txHash)) {
          return global.deployerCache.get(txHash);
        }
        
        // Check if this is a known transaction with a verified deployer
        const normalizedTxHash = txHash.toLowerCase();
        if (KNOWN_DEPLOYERS[normalizedTxHash]) {
          const knownDeployer = KNOWN_DEPLOYERS[normalizedTxHash];
          logger.info(`Using known deployer ${knownDeployer} for transaction ${txHash}`);
          global.deployerCache.set(txHash, knownDeployer);
          return knownDeployer;
        }
        
        // Get transaction
        logger.info(`Fetching transaction details for ${txHash}`);
        const tx = await provider.getTransaction(txHash);
        
        if (!tx || !tx.data) {
          logger.warn(`No transaction data found for ${txHash}`);
          return null;
        }
        
        const inputData = tx.data;
        logger.info(`Got transaction input data for ${txHash}, length: ${inputData.length}`);
        
        // Method ID is the first 4 bytes (8 hex characters) after "0x"
        const methodId = inputData.slice(0, 10);
        logger.info(`Method ID: ${methodId}`);
        
        // For the KOA factory deployToken method (0xaaf29850), we can decode the parameters
        if (methodId === '0xaaf29850') {
          try {
            // Decode the transaction input
            const decoded = koaFactoryInterface.parseTransaction({ data: inputData });
            
            if (decoded && decoded.args) {
              // Log all the decoded parameters for debugging
              logger.info(`Decoded transaction parameters for ${txHash}:`);
              for (let i = 0; i < decoded.args.length; i++) {
                const argValue = decoded.args[i] ? 
                  (typeof decoded.args[i] === 'object' && decoded.args[i].toString ? 
                    decoded.args[i].toString() : 
                    String(decoded.args[i])) 
                  : 'null';
                
                // Fixed: avoid referencing function fragment inputs directly
                const paramName = i === 6 ? '_deployer' : `param${i}`;
                logger.info(`  Param #${i} (${paramName}): ${argValue}`);
              }
              
              // The _deployer address should be the 7th parameter (index 6)
              if (decoded.args.length > 6 && decoded.args[6]) {
                const deployer = decoded.args[6];
                logger.info(`Found _deployer parameter from transaction: ${deployer}`);
                
                // Verify this is a valid address and not an excluded address
                if (ethers.isAddress(deployer) && !shouldExcludeAddress(deployer)) {
                  global.deployerCache.set(txHash, deployer);
                  return deployer;
                } else {
                  logger.info(`_deployer parameter ${deployer} is excluded or invalid`);
                }
              }
            }
          } catch (decodeError) {
            logger.error(`Error decoding transaction input: ${decodeError.message}`);
            logger.error(decodeError.stack);
          }
        }
        
        return null;
      } catch (error) {
        logger.error(`Error getting deployer from transaction: ${error.message}`);
        return null;
      }
    }
    
    // Get the last processed block number
    async function getLastProcessedBlock() {
      try {
        const data = await fs.readFile(STATE_FILE, 'utf8');
        return JSON.parse(data).lastBlock;
      } catch (error) {
        // If file doesn't exist, return 0
        return 0;
      }
    }

    // Save the last processed block number
    async function saveLastProcessedBlock(blockNumber) {
      try {
        await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
        await fs.writeFile(STATE_FILE, JSON.stringify({ lastBlock: blockNumber }));
      } catch (error) {
        logger.error('Error saving last processed block:', error);
      }
    }

    // Process tokens in batches with rate limiting
    async function processTokensInBatches(tokens, provider) {
      const batches = [];
      for (let i = 0; i < tokens.length; i += BATCH_CONFIG.maxBatchSize) {
        batches.push(tokens.slice(i, i + BATCH_CONFIG.maxBatchSize));
      }

      let delay = RATE_LIMIT.initialDelay;
      for (const batch of batches) {
        try {
          // Process the batch
          await tokenStorageService.storeTokens(batch);
          logger.info(`Processed batch of ${batch.length} tokens`);

          // Add delay between batches
          if (batches.indexOf(batch) < batches.length - 1) {
            await new Promise(resolve => setTimeout(resolve, delay));
            delay = Math.min(delay * RATE_LIMIT.backoffFactor, RATE_LIMIT.maxDelay);
          }
        } catch (error) {
          logger.error('Error processing batch:', error);
          // On error, increase delay more aggressively
          delay = Math.min(delay * RATE_LIMIT.backoffFactor * 2, RATE_LIMIT.maxDelay);
        }
      }
    }

    /**
     * Fetch tokens deployed by KOA factory
     */
    async function fetchAndStoreTokens() {
      try {
        logger.info('Fetching tokens deployed by KOA factory...');
        
        // Create a provider with rate limiting
        const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL);
        
        // Calculate the event topic
        const eventTopic = ethers.id(TOKEN_CREATED_EVENT);
        
        // Get the current block number
        const currentBlock = await provider.getBlockNumber();
        logger.info(`Current block: ${currentBlock}`);
        
        // Get last processed block
        const lastProcessedBlock = await getLastProcessedBlock();
        logger.info(`Last processed block: ${lastProcessedBlock}`);
        
        // If we're up to date, no need to scan
        if (currentBlock <= lastProcessedBlock) {
          logger.info('Already up to date with blockchain');
          return;
        }
        
        // Calculate scan range (with a maximum limit)
        const MAX_BLOCKS_PER_SCAN = 500; // Scan last 500 blocks
        
        const scanRange = Math.min(
          currentBlock - lastProcessedBlock,
          MAX_BLOCKS_PER_SCAN
        );
        
        const startBlock = Math.max(0, currentBlock - scanRange);
        logger.info(`Scanning blocks ${startBlock} to ${currentBlock} [${scanRange} blocks]`);
        
        // Process in chunks to avoid timeout issues
        const CHUNK_SIZE = 1000;
        const allTokens = [];
        
        for (let chunkStart = startBlock; chunkStart < currentBlock; chunkStart += CHUNK_SIZE) {
          const chunkEnd = Math.min(chunkStart + CHUNK_SIZE - 1, currentBlock);
          
          logger.info(`Processing block chunk ${chunkStart} to ${chunkEnd} [${chunkEnd - chunkStart + 1} blocks]`);
          
          try {
            // Query for events in this chunk
            const filter = {
              address: FACTORY_ADDRESS,
              topics: [eventTopic],
              fromBlock: chunkStart,
              toBlock: chunkEnd
            };
            
            // Get logs for this chunk
            const logs = await provider.getLogs(filter);
            logger.info(`Found ${logs.length} token creation events in blocks ${chunkStart}-${chunkEnd}`);
            
            // Process the logs
            for (const log of logs) {
              try {
                // The event parameters are ABI encoded in the data field
                const decodedData = ethers.AbiCoder.defaultAbiCoder().decode(
                  ['address', 'uint256', 'address', 'string', 'string', 'uint256', 'address', 'uint256'],
                  log.data
                );
                
                const tokenAddress = decodedData[0];
                const name = decodedData[3];
                const symbol = decodedData[4];
                const supply = decodedData[5];
                
                // Get deployer from transaction
                const deployer = await getDeployerFromTransaction(log.transactionHash, provider);
                
                const tokenData = {
                  contractAddress: tokenAddress.toLowerCase(),
                  name: name,
                  symbol: symbol,
                  decimals: 18,
                  supply: supply.toString(),
                  deployer: deployer ? deployer.toLowerCase() : null,
                  createdAt: new Date(),
                  transactionHash: log.transactionHash,
                  blockNumber: log.blockNumber
                };
                
                allTokens.push(tokenData);
              } catch (error) {
                logger.error(`Error decoding event data:`, error);
              }
            }
            
            // Add delay between chunks to avoid rate limiting
            if (chunkEnd < currentBlock) {
              const delay = Math.min(
                RATE_LIMIT.initialDelay * Math.pow(RATE_LIMIT.backoffFactor, Math.floor((chunkEnd - startBlock) / CHUNK_SIZE)),
                RATE_LIMIT.maxDelay
              );
              await new Promise(resolve => setTimeout(resolve, delay));
            }
          } catch (error) {
            logger.error(`Error processing block chunk ${chunkStart}-${chunkEnd}:`, error);
            // On error, wait longer before next chunk
            await new Promise(resolve => setTimeout(resolve, RATE_LIMIT.maxDelay));
          }
        }
        
        // Process all found tokens in batches
        if (allTokens.length > 0) {
          await processTokensInBatches(allTokens, provider);
          logger.info(`Processed ${allTokens.length} tokens from blocks ${startBlock} to ${currentBlock}`);
        } else {
          logger.info('No new tokens found');
        }
        
        // Save the last processed block
        await saveLastProcessedBlock(currentBlock);
        
      } catch (error) {
        logger.error('Error in fetchAndStoreTokens:', error);
      }
    }
    
    /**
     * Find V3 pools for existing tokens that haven't been checked yet
     */
    async function updateExistingTokenPools() {
      try {
        logger.info('Checking for V3 pools for existing tokens...');
        
        // Create provider for querying pools
        const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL);
        
        // Get tokens that haven't been checked for pools yet
        const tokensToCheck = await Token.find(
          { hasV3Pool: { $exists: false } },
          null,
          { limit: 50 }  // Process in batches of 50
        );
        
        if (tokensToCheck.length === 0) {
          logger.info('No unchecked tokens found for pool lookup');
          return;
        }
        
        logger.info(`Found ${tokensToCheck.length} tokens to check for V3 pools`);
        
        // Process tokens
        await poolService.processTokenPools(tokensToCheck, provider);
        
      } catch (error) {
        logger.error('Error updating existing token pools:', error);
      }
    }
    
    // Initialize data fetching
    async function initializeDataFetching() {
      logger.info('Initializing data fetching service...');
      
      // Do a full scan on startup
      await fetchAndStoreTokens();
      
      // Check pools for existing tokens
      await updateExistingTokenPools();
      
      // Setup scheduled jobs
      // Scan for new tokens every minute
      cron.schedule('* * * * *', fetchAndStoreTokens);
      
      // Update pools for unchecked tokens every 15 minutes
      cron.schedule('*/30 * * * *', updateExistingTokenPools);
      
      logger.info('Data fetching service initialized with scheduled jobs');
    }
    
    // Start everything
    logger.info('Starting blockchain collector...');
    await initializeDataFetching();
    
    // Handle graceful shutdown
    process.on('SIGTERM', async () => {
      logger.info('SIGTERM received, shutting down');
      try {
        await db.closeConnection();
        process.exit(0);
      } catch (err) {
        logger.error('Error during shutdown:', err);
        process.exit(1);
      }
    });
    
  } catch (error) {
    logger.error('Error starting collector:', error);
    process.exit(1);
  }
})();

