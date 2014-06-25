var fs = require('fs');

var async = require('async');

var apiInterfaces = require('./apiInterfaces.js')(config.daemon, config.wallet);

var logSystem = 'unlocker';
require('./exceptionWriter.js')(logSystem);


log('info', logSystem, 'Started');


//Use this in payment processing to get block info once batch RPC is supported
/*
var batchArray = [
    ['getblockheaderbyheight', {height: 21}],
    ['getblockheaderbyheight', {height: 22}],
    ['getblockheaderbyheight', {height: 23
    }]
];

apiInterfaces.batchRpcDaemon(batchArray, function(error, response){

});
*/


function runInterval(){
    async.waterfall([

        //Get all pending blocks in redis
        function(callback){
            redisClient.smembers(config.coin + ':blocksPending', function(error, result){
                if (error){
                    log('error', logSystem, 'Error trying to get pending blocks from redis %j', [error]);
                    callback(true);
                    return;
                }
                if (result.length === 0){
                    log('info', logSystem, 'No pending blocks in redis');
                    callback(true);
                    return;
                }
                var blocks = result.map(function(item){
                    var parts = item.split(':');
                    return {
                        height: parseInt(parts[0]),
                        difficulty: parseInt(parts[1]),
                        hash: parts[2],
                        serialized: item
                    };
                });
                callback(null, blocks);
            });
        },

        //Check if blocks are orphaned
        function(blocks, callback){
            async.filter(blocks, function(block, mapCback){
                apiInterfaces.rpcDaemon('getblockheaderbyheight', {height: block.height}, function(error, result){
                    if (error){
                        log('error', logSystem, 'Error with getblockheaderbyheight RPC request for block %s - %j', [block.serialized, error]);
                        block.unlocked = false;
                        mapCback();
                        return;
                    }
                    if (!result.block_header){
                        log('error', logSystem, 'Error with getblockheaderbyheight, no details returned for %s - %j', [block.serialized, result]);
                        block.unlocked = false;
                        mapCback();
                        return;
                    }
                    var blockHeader = result.block_header;
                    block.orphan = (blockHeader.hash !== block.hash);
                    block.unlocked = blockHeader.depth >= config.blockUnlocker.depth;
                    block.reward = blockHeader.reward;
                    mapCback(block.unlocked);
                });
            }, function(unlockedBlocks){

                if (unlockedBlocks.length === 0){
                    log('info', logSystem, 'No pending blocks are unlocked or orphaned yet (%d pending)', [blocks.length]);
                    callback(true);
                    return;
                }

                callback(null, unlockedBlocks)
            })
        },

        //Get worker shares for each unlocked block
        function(blocks, callback){


            var redisCommands = blocks.map(function(block){
                return ['hgetall', config.coin + ':shares:round' + block.height];
            });


            redisClient.multi(redisCommands).exec(function(error, replies){
                if (error){
                    log('error', logSystem, 'Error with getting round shares from redis %j', [error]);
                    callback(true);
                    return;
                }
                for (var i = 0; i < replies.length; i++){
                    blocks[i].workerShares = replies[i];
                }
                callback(null, blocks);
            });

        },

        //Handle orphaned blocks
        function(blocks, callback){
            var orphanCommands = [];
            blocks.forEach(function(block){
                if (!block.orphan) return;
                var workerShares = block.workerShares;
                orphanCommands.push(['del', config.coin + ':shares:round' + block.height]);
                orphanCommands.push(['smove', config.coin + ':blocksPending', config.coin + ':blocksOrphaned', block.serialized]);

                if (!workerShares || workerShares.constructor !== Object) return;
                Object.keys(workerShares).forEach(function(worker){
                    orphanCommands.push(['hincrby', config.coin + ':shares:roundCurrent',
                        worker, workerShares[worker]]);
                });
            });
            if (orphanCommands.length > 0){
                redisClient.multi(orphanCommands).exec(function(error, replies){
                    if (error){
                        log('error', logSystem, 'Error with cleaning up data in redis for orphan block(s) %j', [error]);
                        callback(true);
                        return;
                    }
                    callback(null, blocks);
                });
            }
            else{
                callback(null, blocks);
            }
        },

        //Handle unlocked blocks
        function(blocks, callback){
            var unlockedBlocksCommands = [];
            var payments = {};
            var totalBlocksUnlocked = 0;
            blocks.forEach(function(block){
                if (block.orphan) return;
                totalBlocksUnlocked++;
                unlockedBlocksCommands.push(['del', config.coin + ':shares:round' + block.height]);
                unlockedBlocksCommands.push(['smove', config.coin + ':blocksPending', config.coin + ':blocksUnlocked', block.serialized]);
                var reward = block.reward - (block.reward * (config.blockUnlocker.poolFee / 100));
                var workerShares = block.workerShares;
                var totalShares = Object.keys(workerShares).reduce(function(p, c){
                    return p + parseInt(workerShares[c])
                }, 0);
                Object.keys(workerShares).forEach(function(worker){
                    var percent = workerShares[worker] / totalShares;
                    var workerReward = reward * percent;
                    payments[worker] = (payments[worker] || 0) + workerReward;
                });
            });

            for (var worker in payments) {
                var amount = parseInt(payments[worker]);
                unlockedBlocksCommands.push(['hincrby', config.coin + ':workers:' + worker, 'balance', amount]);
            }

            if (unlockedBlocksCommands.length === 0){
                log('info', logSystem, 'No unlocked blocks yet (%d pending)', [blocks.length]);
                callback(true);
                return;
            }

            redisClient.multi(unlockedBlocksCommands).exec(function(error, replies){
                if (error){
                    log('error', logSystem, 'Error with unlocking blocks %j', [error]);
                    callback(true);
                    return;
                }
                log('info', logSystem, 'Unlocked %d blocks and update balances for %d workers', [totalBlocksUnlocked, Object.keys(payments).length]);
                callback(null);
            });

        }

    ], function(error, result){
        setTimeout(runInterval, config.blockUnlocker.interval * 1000);
    })
}

runInterval();