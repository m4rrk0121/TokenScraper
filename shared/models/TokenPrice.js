const mongoose = require('mongoose');

const TokenPriceSchema = new mongoose.Schema({
  contractAddress: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    // Removed // index: true removed if it was here
  },
  price_usd: {
    type: Number,
    default: 0
  },
  fdv_usd: {
    type: Number,
    default: 0
  },
  volume_usd: {
    type: Number,
    default: 0
  },
  // New fields for additional time-frame volume data
  volume_usd_h6: {
    type: Number,
    default: 0
  },
  volume_usd_h1: {
    type: Number,
    default: 0
  },
  // Fields for pool data
  pool_address: {
    type: String,
    lowercase: true,
    trim: true
  },
  pool_reserve_in_usd: {
    type: Number,
    default: 0
  },
  last_updated: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Define all indexes in one place
TokenPriceSchema.index({ contractAddress: 1 });
TokenPriceSchema.index({ volume_usd: -1 });
TokenPriceSchema.index({ price_usd: -1 });

module.exports = mongoose.model('TokenPrice', TokenPriceSchema);