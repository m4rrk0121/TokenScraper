// blockchain-collector/collector.js
require('dotenv').config();
const cron = require('node-cron');
const mongoose = require('mongoose');
const axios = require('axios');
const db = require('../shared/config/db');
const { ethers } = require('ethers');
const logger = require('../shared/utils/logger');

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
    
    // Define the KOA factory interface for decoding - using the CORRECT function signature from the contract
    const koaFactoryInterface = new ethers.Interface([
      "function deployToken(string _name, string _symbol, uint256 _supply, int24 _initialTick, uint24 _fee, bytes32 _salt, address _deployer, address _recipient, uint256 _recipientAmount) payable returns (address tokenAddress, uint256 tokenId)"
    ]);

    // Persistent state to track last processed block
    let lastProcessedBlock = null;

    /**
     * Fetch tokens deployed by KOA factory since last run
     */
    async function fetchAndStoreTokens() {
      try {
        logger.info('Fetching tokens deployed by KOA factory...');
        
        // Create a simplified RPC provider
        const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL || "https://rpc.ankr.com/base");
        
        // Get the current block number
        const currentBlock = await provider.getBlockNumber();
        logger.info(`Current block: ${currentBlock}`);
        
        // Determine start block
        const startBlock = lastProcessedBlock ? lastProcessedBlock + 1 : currentBlock - 100; // Default to last 100 blocks if no last processed block
        
        logger.info(`Scanning from block ${startBlock} to ${currentBlock}`);
        
        // Calculate the event topic
        const eventTopic = ethers.id(TOKEN_CREATED_EVENT);
        
        // Query for events in this block range
        const filter = {
          address: FACTORY_ADDRESS,
          topics: [eventTopic],
          fromBlock: startBlock,
          toBlock: currentBlock
        };
        
        // Get logs for this range
        const logs = await provider.getLogs(filter);
        logger.info(`Found ${logs.length} token creation events in blocks ${startBlock}-${currentBlock}`);
        
        // Process the logs
        const chunkTokens = [];
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
            
            // Get the deployer from the transaction input parameters
            const paramDeployer = await getDeployerFromTransaction(log.transactionHash, provider);
            
            // If we couldn't get the parameter deployer, fall back to legacy deployer from event
            const legacyDeployer = decodedData[2]; // This is actually tx.from based on the contract
            
            let finalDeployer;
            if (paramDeployer && !shouldExcludeAddress(paramDeployer)) {
              // Use the parameter deployer if available and not excluded
              finalDeployer = paramDeployer;
              logger.info(`Using _deployer parameter as deployer: ${finalDeployer}`);
            } else if (!shouldExcludeAddress(legacyDeployer)) {
              // Fall back to legacy deployer if parameter deployer not available
              finalDeployer = legacyDeployer;
              logger.info(`Parameter deployer not available, using legacy deployer: ${legacyDeployer}`);
            } else {
              // If both are excluded, use a reasonable fallback
              const tx = await provider.getTransaction(log.transactionHash);
              finalDeployer = tx?.from || 'unknown';
              logger.info(`All deployer options excluded, using transaction sender: ${finalDeployer}`);
            }
            
            logger.info(`Found token: ${name} (${symbol}) at ${tokenAddress}`);
            
            chunkTokens.push({
              contractAddress: tokenAddress.toLowerCase(),
              name,
              symbol,
              decimals: 18,
              createdAt: new Date(log.blockNumber * 2000), // Approximate timestamp
              deployer: finalDeployer.toLowerCase(),
              blockNumber: log.blockNumber
            });
          } catch (error) {
            logger.error(`Error decoding event data:`, error.message);
          }
        }
        
        // Store tokens if any were found
        if (chunkTokens.length > 0) {
          try {
            logger.info(`Storing ${chunkTokens.length} tokens from blocks ${startBlock}-${currentBlock}`);
            const result = await tokenStorageService.storeTokens(chunkTokens);
            logger.info(`Storage complete: ${result.newTokens} new, ${result.updatedTokens} updated`);
            
            // Find and store V3 pool information for new tokens
            logger.info(`Looking for V3 pools for tokens`);
            await poolService.processTokenPools(chunkTokens, provider);
          } catch (storageError) {
            logger.error(`Error storing tokens:`, storageError);
          }
        } else {
          logger.info(`No tokens found in blocks ${startBlock}-${currentBlock}`);
        }
        
        // Update last processed block
        lastProcessedBlock = currentBlock;
        
      } catch (error) {
        logger.error('Error in fetchAndStoreTokens:', error);
      }
    }
    
    // Helper functions (shouldExcludeAddress, getDeployerFromTransaction) remain the same as in the original script
    
    // Initialize data fetching
    async function initializeDataFetching() {
      logger.info('Initializing data fetching service...');
      
      // Create provider for initial block number
      const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL || "https://rpc.ankr.com/base");
      
      // Set initial last processed block
      lastProcessedBlock = await provider.getBlockNumber();
      
      // Setup scheduled job to run every 30 seconds
      const job = cron.schedule('*/30 * * * * *', async () => {
        try {
          await fetchAndStoreTokens();
        } catch (error) {
          logger.error('Error in scheduled job:', error);
        }
      });
      
      logger.info('Data fetching service initialized with 30-second interval job');
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