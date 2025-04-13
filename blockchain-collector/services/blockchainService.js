// blockchain-collector/services/blockchainService.js
const { ethers } = require('ethers');
const constants = require('../../shared/config/constants');
const logger = require('../../shared/utils/logger');
const eventDecoder = require('../utils/eventDecoder');
const tokenStorageService = require('./tokenStorageService');

// Initialize WebSocket provider
const provider = new ethers.WebSocketProvider(
  process.env.BASE_WS_URL || "wss://rpc.ankr.com/base/ws"
);

// Track active subscription
let subscription = null;

/**
 * Process a single token event
 */
async function processTokenEvent(log) {
  try {
    const tokenData = eventDecoder.decodeTokenCreatedEvent(log);
    if (tokenData) {
      await tokenStorageService.storeTokens([tokenData]);
      logger.info(`Processed new token: ${tokenData.address}`);
    }
  } catch (error) {
    logger.error(`Error processing token event:`, error);
  }
}

/**
 * Start monitoring for new tokens
 */
async function startTokenMonitoring() {
  try {
    logger.info('Starting token monitoring via WebSocket...');
    
    // Calculate the event topic
    const eventTopic = ethers.id(constants.TOKEN_CREATED_EVENT);
    
    // Subscribe to token creation events
    subscription = provider.on({
      address: constants.FACTORY_ADDRESS,
      topics: [eventTopic]
    }, async (log) => {
      await processTokenEvent(log);
    });
    
    logger.info('WebSocket subscription active');
    
    // Handle WebSocket connection events
    provider._websocket.on('open', () => {
      logger.info('WebSocket connection established');
    });
    
    provider._websocket.on('close', () => {
      logger.warn('WebSocket connection closed, attempting to reconnect...');
      // The provider will automatically attempt to reconnect
    });
    
    provider._websocket.on('error', (error) => {
      logger.error('WebSocket error:', error);
    });
    
  } catch (error) {
    logger.error('Error starting token monitoring:', error);
    throw error;
  }
}

/**
 * Stop monitoring for new tokens
 */
async function stopTokenMonitoring() {
  if (subscription) {
    await subscription.removeAllListeners();
    subscription = null;
    logger.info('Token monitoring stopped');
  }
}

module.exports = {
  startTokenMonitoring,
  stopTokenMonitoring
};