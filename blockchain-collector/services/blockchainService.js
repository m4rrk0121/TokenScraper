// blockchain-collector/services/blockchainService.js
const { ethers } = require('ethers');
const constants = require('../../shared/config/constants');
const logger = require('../../shared/utils/logger');
const eventDecoder = require('../utils/eventDecoder');
const tokenStorageService = require('./tokenStorageService');

// Initialize provider
const provider = new ethers.JsonRpcProvider(
  process.env.BASE_RPC_URL || "https://rpc.ankr.com/base"
);

/**
 * Fetch tokens from blockchain events
 */
async function collectTokens() {
  try {
    logger.info('Fetching tokens deployed by KOA factory...');
    
    // Calculate the event topic
    const eventTopic = ethers.id(constants.TOKEN_CREATED_EVENT);
    
    // Get the current block number
    const currentBlock = await provider.getBlockNumber();
    logger.info(`Current block: ${currentBlock}`);
    
    // Focus on the last N blocks
    const startBlock = Math.max(0, currentBlock - constants.BLOCKS_TO_SCAN);
    
    logger.info(`Fetching events from block ${startBlock} to ${currentBlock}`);
    
    // Query for events
    const filter = {
      address: constants.FACTORY_ADDRESS,
      topics: [eventTopic],
      fromBlock: startBlock,
      toBlock: currentBlock
    };
    
    const tokens = [];
    
    try {
      const logs = await provider.getLogs(filter);
      logger.info(`Found ${logs.length} token creation events`);
      
      // Process the logs
      for (const log of logs) {
        try {
          const tokenData = eventDecoder.decodeTokenCreatedEvent(log);
          if (tokenData) {
            tokens.push(tokenData);
          }
        } catch (error) {
          logger.error(`Error decoding event data:`, error);
        }
      }
    } catch (error) {
      logger.error(`Error fetching logs:`, error);
    }
    
    // Store tokens in database
    if (tokens.length > 0) {
      await tokenStorageService.storeTokens(tokens);
      logger.info(`Processed ${tokens.length} tokens`);
    } else {
      logger.info('No new tokens found');
    }
    
    return { success: true, tokensProcessed: tokens.length };
  } catch (error) {
    logger.error('Error in collectTokens:', error);
    throw error;
  }
}

module.exports = {
  collectTokens
};