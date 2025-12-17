
import transactionExecutor from './src/execution/transactionExecutor.js';
import { ethers } from 'ethers';

// Mock logger to avoid console spam
const mockLogger = {
    info: () => {},
    warn: () => {},
    error: console.error,
    debug: () => {},
    transactionStart: () => {},
    transactionSuccess: () => {},
    transactionFailed: () => {}
};

async function testLossGeneration() {
    console.log('🧪 Testing Loss Generation Logic...');

    // Reduce estimated profit to make loss more likely with current gas prices
    const opportunity = {
        id: 'test-opp',
        token: 'TEST',
        network: 'ethereum',
        fromDex: 'Uniswap',
        toDex: 'Sushiswap',
        optimalAmount: 1.0,
        estimatedProfit: 0.001, // Reduced from 0.01 to 0.001
        profitPercentage: 1.0,
        gasCosts: { totalGasCost: 0.005 },
        timestamp: Date.now()
    };

    const confirmation = {
        gasUsed: 150000 // More realistic gas for swap (not 21000)
    };

    let positiveCount = 0;
    let negativeCount = 0;
    const iterations = 100;

    console.log(`Running ${iterations} iterations to check for negative profits...`);

    for (let i = 0; i < iterations; i++) {
        const profit = await transactionExecutor.calculateActualProfit(opportunity, confirmation);
        
        if (profit < 0) {
            negativeCount++;
            if (negativeCount <= 5) {
                 console.log(`[Loss Detected] Profit: ${profit.toFixed(6)} ETH`);
            }
        } else {
            positiveCount++;
        }
    }

    console.log(`Results: ${positiveCount} Positive, ${negativeCount} Negative`);

    if (negativeCount > 0) {
        console.log('✅ Success: Losses are possible.');
    } else {
        console.log('❌ Failure: No losses generated.');
    }
}

testLossGeneration().catch(console.error);
