// blockchain-collector/services/tokenStorageService.js
const Token = require('../../shared/models/Token');
const logger = require('../../shared/utils/logger');

/**
 * Store token data in the database using bulk write
 * @param {Array} tokens Array of token objects
 */
async function storeTokens(tokens) {
  try {
    if (!tokens || tokens.length === 0) {
      logger.info('No tokens to store');
      return { success: true, newTokens: 0, updatedTokens: 0 };
    }
    
    logger.info(`Preparing bulk write operation for ${tokens.length} tokens`);
    
    // Prepare operations for bulk write
    const operations = tokens.map(token => ({
      updateOne: {
        filter: { contractAddress: token.contractAddress.toLowerCase() },
        update: { 
          $set: {
            ...token,
            blockNumber: undefined // Remove blockNumber from $set
          },
          $setOnInsert: { 
            blockNumber: token.blockNumber // Only set blockNumber on insert
          }
        },
        upsert: true
      }
    }));
    
    // Perform the bulk write with explicit timeout settings
    logger.info(`Executing bulk write for ${operations.length} operations`);
    const startTime = Date.now();
    
    const result = await Token.bulkWrite(operations, {
      maxTimeMS: 60000,  // 60 second timeout
      ordered: false     // Continue processing even if some operations fail
    });
    
    const duration = Date.now() - startTime;
    
    logger.info(`Bulk write completed in ${duration}ms`);
    logger.info(`Results: ${result.upsertedCount} new tokens, ${result.modifiedCount} modified tokens`);
    
    return {
      success: true,
      newTokens: result.upsertedCount,
      updatedTokens: result.modifiedCount
    };
  } catch (error) {
    logger.error('Error storing tokens in bulk:', error);
    
    // If bulk operation fails, try a fallback to one-by-one approach
    logger.info('Attempting fallback to one-by-one processing');
    return storeTokensIndividually(tokens);
  }
}

/**
 * Fallback method to store tokens individually if bulk operation fails
 * @param {Array} tokens Array of token objects
 */
async function storeTokensIndividually(tokens) {
  try {
    let newTokens = 0;
    let updatedTokens = 0;
    
    logger.info(`Processing ${tokens.length} tokens individually as fallback`);
    
    for (const token of tokens) {
      try {
        // Use findOneAndUpdate with explicit timeout
        const result = await Token.findOneAndUpdate(
          { contractAddress: token.contractAddress.toLowerCase() },
          { $set: token },
          { 
            upsert: true, 
            new: true,
            maxTimeMS: 30000
          }
        );
        
        if (result && result._id) {
          // Check if new or updated based on timestamps
          if (result.createdAt && result.updatedAt && 
              result.createdAt.getTime() === result.updatedAt.getTime()) {
            newTokens++;
          } else {
            updatedTokens++;
          }
        }
      } catch (tokenError) {
        logger.error(`Error processing token ${token.contractAddress}: ${tokenError.message}`);
      }
      
      // Add a small delay between operations
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    
    logger.info(`Fallback processing complete: ${newTokens} new, ${updatedTokens} updated`);
    
    return {
      success: true,
      newTokens,
      updatedTokens
    };
  } catch (error) {
    logger.error('Error in fallback token processing:', error);
    throw error;
  }
}

module.exports = {
  storeTokens
};