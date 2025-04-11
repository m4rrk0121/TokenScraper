// blockchain-collector/services/poolService.js
const { ethers } = require('ethers');
const Token = require('../../shared/models/Token');
const logger = require('../../shared/utils/logger');

// Uniswap V3 Factory address on Base
const UNISWAP_V3_FACTORY = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';

// Commonly paired tokens on Base
const COMMON_PAIRS = [
  { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH' },
  { address: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', symbol: 'USDbC' },
  { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC' }
];

// Fee tiers in Uniswap V3
const FEE_TIERS = [500, 3000, 10000];

// Uniswap V3 Factory ABI (just the function we need)
const FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)'
];

// Uniswap V3 Pool ABI (just what we need)
const POOL_ABI = [
  'function liquidity() view returns (uint128)',
  'function token0() view returns (address)',
  'function token1() view returns (address)'
];

/**
 * Find and update V3 pool information for a token
 * @param {string} tokenAddress - Token contract address
 * @param {ethers.JsonRpcProvider} provider - Blockchain provider
 * @returns {Promise<Object>} Pool information
 */
async function findV3Pools(tokenAddress, provider) {
  try {
    tokenAddress = tokenAddress.toLowerCase();
    logger.info(`Looking for V3 pools for token ${tokenAddress}`);
    
    // Create Uniswap V3 Factory contract instance
    const factory = new ethers.Contract(
      UNISWAP_V3_FACTORY,
      FACTORY_ABI,
      provider
    );
    
    const pools = [];
    
    // Check for pools with common paired tokens across fee tiers
    for (const pair of COMMON_PAIRS) {
      for (const fee of FEE_TIERS) {
        try {
          // Get pool address from factory
          const poolAddress = await factory.getPool(
            tokenAddress,
            pair.address,
            fee
          );
          
          // Skip if pool doesn't exist (address is zero)
          if (poolAddress === ethers.ZeroAddress) {
            continue;
          }
          
          logger.info(`Found V3 pool at ${poolAddress} for ${tokenAddress}/${pair.symbol} with fee ${fee/10000}%`);
          
          // Create pool contract instance
          const poolContract = new ethers.Contract(
            poolAddress,
            POOL_ABI,
            provider
          );
          
          // Get pool liquidity
          const liquidity = await poolContract.liquidity();
          
          // Verify token addresses to determine which is token0/token1
          const token0 = (await poolContract.token0()).toLowerCase();
          const token1 = (await poolContract.token1()).toLowerCase();
          
          // Make sure our token is actually in this pool
          if (token0 !== tokenAddress && token1 !== tokenAddress) {
            logger.warn(`Pool ${poolAddress} doesn't contain token ${tokenAddress}, skipping`);
            continue;
          }
          
          // Add to pools array
          pools.push({
            address: poolAddress.toLowerCase(),
            pairWith: pair.address.toLowerCase(),
            pairSymbol: pair.symbol,
            fee: fee,
            liquidity: liquidity.toString()
          });
          
        } catch (error) {
          logger.error(`Error checking pool for ${tokenAddress}/${pair.symbol} with fee ${fee/10000}%: ${error.message}`);
        }
      }
    }
    
    return pools;
  } catch (error) {
    logger.error(`Error finding V3 pools for ${tokenAddress}: ${error.message}`);
    return [];
  }
}

/**
 * Update token with V3 pool information
 * @param {Object} token - Token object
 * @param {ethers.JsonRpcProvider} provider - Blockchain provider
 */
async function updateTokenWithPools(token, provider) {
  try {
    const tokenAddress = token.contractAddress;
    
    // Find pools for this token
    const pools = await findV3Pools(tokenAddress, provider);
    
    if (pools.length > 0) {
      // Update token in database
      await Token.findOneAndUpdate(
        { contractAddress: tokenAddress },
        { 
          $set: { 
            v3Pools: pools,
            hasV3Pool: true
          }
        },
        { maxTimeMS: 30000 }
      );
      
      logger.info(`Updated token ${tokenAddress} with ${pools.length} V3 pools`);
      return true;
    } else {
      // Mark as checked but no pools found
      await Token.findOneAndUpdate(
        { contractAddress: tokenAddress },
        { $set: { hasV3Pool: false } },
        { maxTimeMS: 30000 }
      );
      
      logger.info(`No V3 pools found for token ${tokenAddress}`);
      return false;
    }
  } catch (error) {
    logger.error(`Error updating token ${token.contractAddress} with pools: ${error.message}`);
    return false;
  }
}

/**
 * Process multiple tokens to find and update their V3 pool information
 * @param {Array} tokens - Array of token objects
 * @param {ethers.JsonRpcProvider} provider - Blockchain provider
 */
async function processTokenPools(tokens, provider) {
  if (!tokens || tokens.length === 0) {
    logger.info('No tokens to process for pools');
    return { success: true, count: 0 };
  }
  
  logger.info(`Processing V3 pools for ${tokens.length} tokens`);
  
  let successCount = 0;
  
  // Process tokens one by one to avoid rate limiting
  for (const token of tokens) {
    try {
      const result = await updateTokenWithPools(token, provider);
      if (result) successCount++;
      
      // Add delay between tokens
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (error) {
      logger.error(`Error processing pools for token ${token.contractAddress}: ${error.message}`);
    }
  }
  
  logger.info(`Completed pool processing for ${successCount} of ${tokens.length} tokens`);
  
  return {
    success: true,
    count: successCount
  };
}

module.exports = {
  findV3Pools,
  updateTokenWithPools,
  processTokenPools
};