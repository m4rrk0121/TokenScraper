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
    
    /**
     * Fetch tokens deployed by KOA factory for the last 50,000 blocks
     */
    async function fetchAndStoreTokens() {
      try {
        logger.info('Fetching tokens deployed by KOA factory...');
        
        // Create a simplified RPC provider
        const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL || "https://rpc.ankr.com/base");
        
        // Calculate the event topic
        const eventTopic = ethers.id(TOKEN_CREATED_EVENT);
        
        // Get the current block number
        const currentBlock = await provider.getBlockNumber();
        logger.info(`Current block: ${currentBlock}`);
        
        // Only scan the last 50,000 blocks
        const BLOCK_RANGE = 500;
        const START_BLOCK = Math.max(0, currentBlock - BLOCK_RANGE);
        
        logger.info(`Scanning the last ${BLOCK_RANGE} blocks from ${START_BLOCK} to ${currentBlock}`);
        
        // Process in chunks of 10,000 blocks to avoid timeout issues
        const CHUNK_SIZE = 50000;
        const allTokens = [];
        
        for (let chunkStart = START_BLOCK; chunkStart < currentBlock; chunkStart += CHUNK_SIZE) {
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
                // This is what you want - the _deployer parameter, not the event's deployer (which is tx.from)
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
                logger.info(`Legacy deployer: ${legacyDeployer}, Parameter deployer: ${paramDeployer || 'not found'}, Final deployer: ${finalDeployer}`);
                
                chunkTokens.push({
                  contractAddress: tokenAddress.toLowerCase(),
                  name,
                  symbol,
                  decimals: 18,
                  createdAt: new Date(log.blockNumber * 2000), // Approximate timestamp
                  deployer: finalDeployer.toLowerCase()
                });
              } catch (error) {
                logger.error(`Error decoding event data:`, error.message);
              }
            }
            
            // Store tokens from this chunk if any were found
            if (chunkTokens.length > 0) {
              allTokens.push(...chunkTokens);
              
              // Process this chunk's tokens right away
              try {
                logger.info(`Storing ${chunkTokens.length} tokens from blocks ${chunkStart}-${chunkEnd}`);
                const result = await tokenStorageService.storeTokens(chunkTokens);
                logger.info(`Chunk storage complete: ${result.newTokens} new, ${result.updatedTokens} updated from blocks ${chunkStart}-${chunkEnd}`);
                
                // Find and store V3 pool information for new tokens
                logger.info(`Looking for V3 pools for tokens from blocks ${chunkStart}-${chunkEnd}`);
                await poolService.processTokenPools(chunkTokens, provider);
              } catch (storageError) {
                logger.error(`Error storing tokens from blocks ${chunkStart}-${chunkEnd}:`, storageError);
              }
            } else {
              logger.info(`No tokens found in blocks ${chunkStart}-${chunkEnd}`);
            }
            
            // Add a delay between chunks to avoid rate limiting
            if (chunkEnd < currentBlock) {
              logger.info('Pausing briefly before processing next block chunk...');
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          } catch (chunkError) {
            logger.error(`Error processing block chunk ${chunkStart}-${chunkEnd}:`, chunkError);
            // Continue with next chunk even if this one failed
          }
        }
        
        logger.info(`Completed scanning ${currentBlock - START_BLOCK} blocks. Found total of ${allTokens.length} tokens`);
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
        const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL || "https://rpc.ankr.com/base");
        
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
