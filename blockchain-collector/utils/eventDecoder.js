// blockchain-collector/utils/eventDecoder.js
const { ethers } = require('ethers');
const logger = require('../../shared/utils/logger');

/**
 * Decode token creation event data
 * @param {Object} log The event log object
 * @returns {Object|null} Decoded token data or null if error
 */
function decodeTokenCreatedEvent(log) {
  try {
    // The event parameters are ABI encoded in the data field
    const decodedData = ethers.AbiCoder.defaultAbiCoder().decode(
      ['address', 'uint256', 'address', 'string', 'string', 'uint256', 'address', 'uint256'],
      log.data
    );
    
    const tokenAddress = decodedData[0];
    const deployer = decodedData[2];
    const name = decodedData[3];
    const symbol = decodedData[4];
    const supply = decodedData[5];
    
    logger.debug(`Decoded token: ${name} (${symbol}) at ${tokenAddress}`);
    
    return {
      contractAddress: tokenAddress.toLowerCase(),
      name,
      symbol,
      decimals: 18, // ERC20 tokens deployed by KOA have 18 decimals
      createdAt: new Date(), // We could estimate from block number but this is more accurate
      deployer: deployer.toLowerCase(),
      blockNumber: log.blockNumber
    };
  } catch (error) {
    logger.error(`Error decoding event data:`, error);
    return null;
  }
}

module.exports = {
  decodeTokenCreatedEvent
};