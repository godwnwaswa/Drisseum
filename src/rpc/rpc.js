// Bad RPC server implementation, will be updated soon.

"use strict";

const Transaction = require("../core/transaction");

const fastify = require("fastify")();

function rpc(PORT, client, transactionHandler, keyPair, stateDB, blockDB, bhashDB, codeDB) {

    process.on("uncaughtException", err => console.log("LOG ::", err));

    fastify.get("/:option", async (req, reply) => {

        function throwError(message, status, payload = null) {
            reply.status(status);

            reply.send({
                success: false,
                payload: null,
                error: { message }
            });
        }

        function respond(payload) {
            reply.send({
                success: true,
                payload
            })
        }

        switch (req.params.option) {
            case "getBlockNumber":
                respond({ blockNumber: Math.max(...(await blockDB.keys().all()).map(key => parseInt(key))) });
                
                break;
            
            case "getAddress":
                respond({ address: client.publicKey });

                break;
            
            case "getWork":
                const latestBlock = await blockDB.get( Math.max(...(await blockDB.keys().all()).map(key => parseInt(key))).toString() );

                respond({
                    hash: latestBlock.hash, 
                    nonce: latestBlock.nonce
                });
                
                break;
            
            case "mining":
                respond({ mining: client.mining });
                
                break;
            
            default:
                throwError("Invalid option.", 404);
        }
    });

    fastify.post("/:option", async (req, reply) => {
        function throwError(message, status, payload = null) {
            reply.status(status);

            reply.send({
                success: false,
                payload: null,
                error: { message }
            });
        }

        function respond(payload) {
            reply.send({
                success: true,
                payload
            })
        }

        switch (req.params.option) {

            case "getBlockByHash":
                if (typeof req.body.params !== "object" || typeof req.body.params.hash !== "string") {
                    throwError("Invalid request.");
                } else {
                    const hashes = (await bhashDB.keys().all());

                    if (!hashes.find(hash => hash === req.body.params.hash)) {
                        throwError("Invalid block hash.", 400);
                    } else {
                        const blockNumber = await bhashDB.get(req.body.params.hash);
                        const block = await blockDB.get(blockNumber);

                        respond({ block });
                    }
                }
                
                break;

            case "getBlockByNumber":
                if (typeof req.body.params !== "object" || typeof req.body.params.blockNumber !== "number") {
                    throwError("Invalid request.");
                } else {
                    const currentBlockNumber = Math.max(...(await blockDB.keys().all()).map(key => parseInt(key)));

                    if (req.body.params.blockNumber <= 0 || req.body.params.blockNumber > currentBlockNumber) {
                        throwError("Invalid block number.", 400);
                    } else {
                        const block = await blockDB.get( req.body.params.blockNumber.toString() );

                        respond({ block });
                    }
                }
                
                break;

            case "getBlockTxnCountByHash":
                if (typeof req.body.params !== "object" || typeof req.body.params.hash !== "string") {
                    throwError("Invalid request.", 400);
                } else {
                    const hashes = (await bhashDB.keys().all());

                    if (!hashes.find(hash => hash === req.body.params.hash)) {
                        throwError("Invalid block hash.", 400);
                    } else {
                        const blockNumber = await bhashDB.get(req.body.params.hash);
                        const block = await blockDB.get(blockNumber);

                        respond({ count: block.transactions.length });
                    }
                }
                
                break;

            case "getBlockTxnCountByNumber":
                if (typeof req.body.params !== "object" || typeof req.body.params.blockNumber !== "number") {
                    throwError("Invalid request.", 400);
                } else {
                    const currentBlockNumber = Math.max(...(await blockDB.keys().all()).map(key => parseInt(key)));

                    if (req.body.params.blockNumber <= 0 || req.body.params.blockNumber > currentBlockNumber) {
                        throwError("Invalid block number.", 400);
                    } else {
                        const block = await blockDB.get( req.body.params.blockNumber.toString() );

                        respond({ count: block.transactions.length });
                    }
                }

                break;
            
            case "getBalance":
                if (
                    typeof req.body.params !== "object"            ||
                    typeof req.body.params.address !== "string"    ||
                    !(await stateDB.keys().all()).includes(req.body.params.address)
                ) {
                    throwError("Invalid request.", 400);
                } else {
                    const dataFromTarget = await stateDB.get(req.body.params.address); // Fetch target's state object
                    const targetBalance = dataFromTarget.balance;                      // Get target's balance

                    respond({ balance: targetBalance });
                }
                
                break;
           
            case "getCode":
                if (
                    typeof req.body.params !== "object"            ||
                    typeof req.body.params.codeHash !== "string"    ||
                    !(await codeDB.keys().all()).includes(req.body.params.codeHash)
                ) {
                    throwError("Invalid request.", 400);
                } else {
                    respond({ code: await codeDB.get(req.body.params.codeHash) });
                }
                
                break;

            case "getCodeHash":
                    if (
                        typeof req.body.params !== "object"            ||
                        typeof req.body.params.address !== "string"    ||
                        !(await stateDB.keys().all()).includes(req.body.params.address)
                    ) {
                        throwError("Invalid request.", 400);
                    } else {
                        const dataFromTarget = await stateDB.get(req.body.params.address); // Fetch target's state object
    
                        respond({ codeHash: dataFromTarget.codeHash });
                    }
                    
                    break;
            
            case "getStorage":
                if (
                    typeof req.body.params !== "object"            ||
                    typeof req.body.params.address !== "string"    ||
                    typeof req.body.params.key !== "string"        ||
                    !(await stateDB.keys().all()).includes(req.body.params.address)
                ) {
                    throwError("Invalid request.", 400);
                } else {
                    const storageDB = new Level(__dirname + "/../log/accountStore/" + contractInfo.address);

                    respond({ storage: await storageDB.get(req.body.params.key) });

                    storageDB.close();
                }
                
                break;
            
            case "getStorageKeys":
                if (
                    typeof req.body.params.address !== "string"    ||
                    !(await stateDB.keys().all()).includes(req.body.params.address)
                ) {
                    throwError("Invalid request.", 400);
                } else {
                    const storageDB = new Level(__dirname + "/../log/accountStore/" + contractInfo.address);

                    respond({ storage: await storageDB.keys().all() });
                }
                
                break;
            
            case "getStorageRoot":
                if (
                    typeof req.body.params.address !== "string"    ||
                    !(await stateDB.keys().all()).includes(req.body.params.address)
                ) {
                    throwError("Invalid request.", 400);
                } else {
                    respond({ storageRoot: (await stateDB.get(contractInfo.address)).storageRoot });
                }
                
                break;
            
            case "getTxnByBlockNumberAndIndex":
                if (
                    typeof req.body.params !== "object" ||
                    typeof req.body.params.blockNumber !== "number" ||
                    typeof req.body.params.index !== "number"
                ) {
                    throwError("Invalid request.", 400);
                } else {
                    const currentBlockNumber = Math.max(...(await blockDB.keys().all()).map(key => parseInt(key)));

                    if (req.body.params.blockNumber <= 0 || req.body.params.blockNumber > currentBlockNumber) {
                        throwError("Invalid block number.", 400);
                    } else {
                        const block = await blockDB.get( req.body.params.blockNumber.toString() );

                        if (req.body.params.index < 0 || req.body.params.index >= block.transactions.length) {
                            throwError("Invalid transaction index.", 400);
                        } else {
                            respond({ transaction: block.transactions[req.body.params.index] });
                        }
                    }
                }

                break;

            case "getTxnByBlockHashAndIndex":
                if (
                    typeof req.body.params !== "object" ||
                    typeof req.body.params.hash !== "string" ||
                    typeof req.body.params.index !== "number"
                ) {
                    throwError("Invalid request.", 400);
                } else {
                    const hashes = (await bhashDB.keys().all());

                    if (!hashes.find(hash => hash === req.body.params.hash)) {
                        throwError("Invalid block hash.", 400);
                    } else {
                        const blockNumber = await bhashDB.get(req.body.params.hash);
                        const block = await blockDB.get(blockNumber);

                        if (req.body.params.index < 0 || req.body.params.index >= block.transactions.length) {
                            throwError("Invalid transaction index.", 400);
                        } else {
                            respond({ transaction: block.transactions[req.body.params.index] });
                        }
                    }
                }

                break;

            case "sendTxn":
                if (
                    typeof req.body.params !== "object" ||
                    typeof req.body.params.transaction !== "object"
                ) {
                    throwError("Invalid request.", 400);
                } else {
                    respond({ message: "tx received." });

                    await transactionHandler(req.body.params.transaction);
                }

                break;
            
            case "signTxn":
                if (
                    typeof req.body.params !== "object" ||
                    typeof req.body.params.transaction !== "object"
                ) {
                    throwError("Invalid request.", 400);
                } else {
                    const transaction = req.body.params.transaction;

                    Transaction.sign(transaction, keyPair);

                    respond({ transaction });
                }

                break;
            
            default:
                throwError("Invalid option.", 404);
        }
    });

    fastify.listen(PORT, (err, address) => {
        if (err) {
            console.log("LOG :: Error at RPC server: Fastify: ", err);
            process.exit(1);
        }

        console.log(`LOG :: RPC server running on PORT ${PORT}`);
    });
}

module.exports = rpc;
