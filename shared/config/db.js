const mongoose = require('mongoose');
const logger = require('../utils/logger');

/**
 * Database connection utility
 */
// Update db.js with these settings
async function connectToDatabase() {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 60000,  // 60 seconds
      socketTimeoutMS: 60000,
      connectTimeoutMS: 60000,
      maxPoolSize: 10,                  // Limit connections 
      minPoolSize: 5,                   // Ensure minimum connections
      writeConcern: {
        w: 1,                          // Only require primary acknowledgement
        wtimeoutMS: 60000               // 60 second timeout for writes
      }
    });
    logger.info('Connected to MongoDB');
    return mongoose.connection;
  } catch (err) {
    logger.error('MongoDB connection error:', err);
    throw err;
  }
}

/**
 * Close database connection gracefully
 */
async function closeConnection() {
  try {
    await mongoose.connection.close();
    logger.info('MongoDB connection closed');
  } catch (err) {
    logger.error('Error closing MongoDB connection:', err);
    throw err;
  }
}

module.exports = {
  connectToDatabase,
  closeConnection
};