var fs = require('fs');
var http = require('http');
var url = require("url");
var zlib = require('zlib');

var async = require('async');
var redis = require('redis');

var apiInterfaces = require('./apiInterfaces.js')(config.daemon, config.wallet);

var logSystem = 'api';
require('./exceptionWriter.js')(logSystem);

var redisCommands = [
    ['zremrangebyscore', config.coin + ':hashrate', '-inf', ''],
    ['zrangebyscore', config.coin + ':hashrate', '', '+inf'],
    ['hgetall', config.coin + ':stats'],
    ['hgetall', config.coin + ':shares:roundCurrent'],
    ['hgetall', config.coin + ':stats']
];

var redisCommands2 = [
    ['smembers', config.coin + ':blocksPending'],
    ['smembers', config.coin + ':blocksUnlocked'],
    ['smembers', config.coin + ':blocksOrphaned']
];


var currentStats = "";
var currentStatsCompressed = "";
var currentBlocksCompressed = "";
var currentBlocks = "";

var minerStats = {};

var liveConnections = {};
var addressConnections = {};

function collectBlocksStats() {
    async.parallel({
        network: function(callback) {
            apiInterfaces.rpcDaemon('getlastblockheader', {}, function(error, reply) {
                if (error) {
                    log('error', logSystem, 'Error getting daemon data %j', [error]);
                    callback(true);
                    return;
                }
                var blockHeader = reply.block_header;
                callback(null, {
                    difficulty: blockHeader.difficulty,
                    height: blockHeader.height,
                    timestamp: blockHeader.timestamp,
                    reward: blockHeader.reward,
                    hash: blockHeader.hash
                });
            });
        },
        stats: function(callback) {
            redisClient.multi(redisCommands2).exec(function(error, replies) {
                if (error) {
                    log('error', logSystem, 'Error getting redis data %j', [error]);
                    callback(true);
                    return;
                }
                var blocks = [];
                var blocksResults = {
                    pending: replies[0],
                    unlocked: replies[1],
                    orphaned: replies[2]
                };

                for (var status in blocksResults) {
                    var blockArray = blocksResults[status];
                    for (var i = 0; i < blockArray.length; i++) {
                        var blockData = blockArray[i].split(':');
                        blockData[0] = parseInt(blockData[0]);
                        blockData.unshift(status);
                        blocks.push(blockData);
                    }
                }

                blocks.sort(function(a, b) {
                    return b[1] - a[1];
                });

                callback(null, {
                    pending: blocksResults.pending.length,
                    unlocked: blocksResults.unlocked.length,
                    orphaned: blocksResults.orphaned.length,
                    blocks: blocks.slice(0, 500)
                });
            });
        },
        config: function(callback) {
            callback(null, {
                ports: config.poolServer.ports,
                hashrateWindow: config.api.hashrateWindow,
                fee: config.blockUnlocker.poolFee,
                coin: config.coin,
                symbol: config.symbol,
                depth: config.blockUnlocker.depth,
                version: config.version
            });
        }
    }, function(error, results) {
        if (error) {
            log('error', logSystem, 'Error collecting all stats');
        } else {
            currentBlocks = JSON.stringify(results);
            zlib.deflateRaw(currentBlocks, function(error, result) {
                currentBlocksCompressed = result;
            });

        }
        setTimeout(collectBlocksStats, config.api.updateInterval * 1000);
    });
}

function collectStats() {

    var windowTime = (((Date.now() / 1000) - config.api.hashrateWindow) | 0).toString();
    redisCommands[0][3] = '(' + windowTime;
    redisCommands[1][2] = windowTime;


    async.parallel({
        pool: function(callback) {
            redisClient.multi(redisCommands).exec(function(error, replies) {
                if (error) {
                    log('error', logSystem, 'Error getting redis data %j', [error]);
                    callback(true);
                    return;
                }

                var data = {
                    stats: replies[2]
                };

                var hashrates = replies[1];

                minerStats = {};

                for (var i = 0; i < hashrates.length; i++) {
                    var hashParts = hashrates[i].split(':');
                    minerStats[hashParts[1]] = (minerStats[hashParts[1]] || 0) + parseInt(hashParts[0]);
                }

                var totalShares = 0;

                for (var miner in minerStats) {
                    var shares = minerStats[miner];
                    totalShares += shares;
                    minerStats[miner] = getReadableHashRateString(shares / config.api.hashrateWindow);
                }

                data.miners = Object.keys(minerStats).length;

                data.hashrate = totalShares / config.api.hashrateWindow;

                data.roundHashes = 0;

                if (replies[3]) {
                    for (var miner in replies[3]) {
                        data.roundHashes += parseInt(replies[3][miner]);
                    }
                }

                if (replies[4]) {
                    data.lastBlockFound = replies[4].lastBlockFound;
                }

                callback(null, data);
            });
        },
        network: function(callback) {
            apiInterfaces.rpcDaemon('getlastblockheader', {}, function(error, reply) {
                if (error) {
                    log('error', logSystem, 'Error getting daemon data %j', [error]);
                    callback(true);
                    return;
                }
                var blockHeader = reply.block_header;
                callback(null, {
                    difficulty: blockHeader.difficulty,
                    height: blockHeader.height,
                    timestamp: blockHeader.timestamp,
                    reward: blockHeader.reward,
                    hash: blockHeader.hash
                });
            });
        },
        config: function(callback) {
            callback(null, {
                ports: config.poolServer.ports,
                hashrateWindow: config.api.hashrateWindow,
                fee: config.blockUnlocker.poolFee,
                coin: config.coin,
                symbol: config.symbol,
                depth: config.blockUnlocker.depth,
                version: config.version
            });
        }
    }, function(error, results) {
        if (error) {
            log('error', logSystem, 'Error collecting all stats');
        } else {
            currentStats = JSON.stringify(results);
            zlib.deflateRaw(currentStats, function(error, result) {
                currentStatsCompressed = result;
                broadcastLiveStats();
            });

        }
        setTimeout(collectStats, config.api.updateInterval * 1000);
    });

}

function getReadableHashRateString(hashrate) {
    var i = 0;
    var byteUnits = [' H', ' KH', ' MH', ' GH', ' TH', ' PH'];
    while (hashrate > 1024) {
        hashrate = hashrate / 1024;
        i++;
    }
    return hashrate.toFixed(2) + byteUnits[i];
}

function broadcastLiveStats() {

    for (var uid in liveConnections) {
        var res = liveConnections[uid];
        res.end(currentStatsCompressed);
    }


    var redisCommands = [];
    for (var address in addressConnections) {
        redisCommands.push(['hgetall', config.coin + ':workers:' + address]);
    }
    redisClient.multi(redisCommands).exec(function(error, replies) {

        var addresses = Object.keys(addressConnections);

        for (var i = 0; i < addresses.length; i++) {
            var address = addresses[i];
            var stats = replies[i];
            var res = addressConnections[address];
            res.end(stats ? formatMinerStats(stats, address) : '{"error": "not found"');
        }
    });
}

function handleMinerStats(urlParts, response) {
    response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json',
        'Connection': 'keep-alive'
    });
    response.write('\n');
    var address = urlParts.query.address;

    if (urlParts.query.longpoll === 'true') {
        redisClient.exists(config.coin + ':workers:' + address, function(error, result) {
            if (!result) {
                response.end(JSON.stringify({
                    error: 'not found'
                }));
                return;
            }
            addressConnections[address] = response;
        });
    } else {
        redisClient.hgetall(config.coin + ':workers:' + address, function(error, stats) {
            if (!stats) {
                response.end(JSON.stringify({
                    error: 'not found'
                }));
                return;
            }
            response.end(formatMinerStats(stats, address));
        });
    }
}


function formatMinerStats(redisData, address) {
    redisData.hashrate = minerStats[address];
    redisData.symbol = config.symbol;
    return JSON.stringify({
        stats: redisData
    });
}

collectBlocksStats();
collectStats();


var server = http.createServer(function(request, response) {

    if (request.method.toUpperCase() === "OPTIONS") {

        response.writeHead("204", "No Content", {
            "access-control-allow-origin": '*',
            "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
            "access-control-allow-headers": "content-type, accept",
            "access-control-max-age": 10, // Seconds.
            "content-length": 0
        });

        return (response.end());
    }


    var urlParts = url.parse(request.url, true);

    switch (urlParts.pathname) {
        case '/blockstats':
            var reply = currentBlocksCompressed;
            response.writeHead("200", {
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-cache',
                'Content-Type': 'application/json',
                'Content-Encoding': 'deflate',
                'Content-Length': reply.length
            });
            response.end(reply);
            break;
        case '/stats':
            var reply = currentStatsCompressed;
            response.writeHead("200", {
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-cache',
                'Content-Type': 'application/json',
                'Content-Encoding': 'deflate',
                'Content-Length': reply.length
            });
            response.end(reply);
            break;
        case '/live_stats':
            response.writeHead(200, {
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-cache',
                'Content-Type': 'application/json',
                'Content-Encoding': 'deflate',
                'Connection': 'keep-alive'
            });
            var uid = Math.random().toString();
            liveConnections[uid] = response;
            response.on("close", function() {
                delete liveConnections[uid];
            });
            break;
        case '/stats_address':
            handleMinerStats(urlParts, response);
            break;
        default:
            response.writeHead(404, {
                'Access-Control-Allow-Origin': '*'
            });
            response.end('Invalid API call');
            break;
    }


});


server.listen(config.api.port, function() {
    log('info', logSystem, 'API started & listening on port %d', [config.api.port]);
});