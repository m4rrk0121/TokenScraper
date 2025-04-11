const mongoose = require('mongoose');

const TokenSchema = new mongoose.Schema({
  contractAddress: { 
    type: String, 
    required: true, 
    unique: true,
    lowercase: true,
  },
  name: String,
  symbol: String,
  decimals: Number,
  createdAt: Date,
  deployer: String,
  blockNumber: Number, // Add this field to store the block number
  // V3 Pool information
  v3Pools: [{
    address: String,
    pairWith: String,  // Address of the paired token (e.g., WETH, USDC)
    pairSymbol: String, // Symbol of the paired token
    fee: Number,       // Pool fee tier (e.g., 0.3%, 1%)
    liquidity: String  // Current liquidity as string to handle large numbers
  }],
  hasV3Pool: { type: Boolean, default: false }
}, { timestamps: true });

// Define all indexes in one place for clarity
TokenSchema.index({ contractAddress: 1 });
// Add any other indexes you need, like text search on name and symbol
TokenSchema.index({ symbol: 'text', name: 'text' });
// Add an index on createdAt for sorting
TokenSchema.index({ createdAt: -1 });
// Add an index on blockNumber for querying by block
TokenSchema.index({ blockNumber: 1 });

module.exports = mongoose.model('Token', TokenSchema);