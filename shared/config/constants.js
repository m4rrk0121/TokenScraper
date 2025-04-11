module.exports = {
    // Blockchain constants
    FACTORY_ADDRESS: '0xb51F74E6d8568119061f59Fd7f98824F1e666AC1',
    TOKEN_CREATED_EVENT: 'TokenCreated(address,uint256,address,string,string,uint256,address,uint256)',
    
    // API endpoints
    GECKO_TERMINAL_API_URL: 'https://api.geckoterminal.com/api/v2',
    
    // Collection settings
    BATCH_SIZE: 30,
    BLOCKCHAIN_SCAN_INTERVAL: '*/5 * * * *',  // Every 5 minutes
    PRICE_UPDATE_INTERVAL: '*/2 * * * *',     // Every 2 minutes
    
    // Block range for event scanning
    BLOCKS_TO_SCAN: 50000
  };