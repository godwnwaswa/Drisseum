"use strict"

const crypto = require("crypto"), SHA256 = message => crypto.createHash("sha256").update(message).digest("hex")
const WS = require("ws")
const EC = require("elliptic").ec, ec = new EC("secp256k1")
const { Level } = require('level')
const { fork } = require("child_process")

const Block = require("../core/block")
const Transaction = require("../core/transaction")
const changeState = require("../core/state")
const { BLOCK_REWARD, BLOCK_GAS_LIMIT, EMPTY_HASH, INITIAL_SUPPLY, FIRST_ACCOUNT } = require("../config.json")
const { produceMessage, sendMessage } = require("./message")
const generateGenesisBlock = require("../core/genesis")
const { addTransaction, clearDepreciatedTxns }= require("../core/txPool")
const rpc = require("../rpc/rpc")
const TYPE = require("./message-types")
const { verifyBlock, updateDifficulty } = require("../consensus/consensus")
const { parseJSON, indexTxns } = require("../utils/utils")
const drisscript = require("../core/runtime")
const { buildMerkleTree } = require("../core/merkle")

const opened    = []  // Addresses and sockets from connected nodes.
const connected = []  // Addresses from connected nodes.
let connectedNodes = 0

let worker = fork(`${__dirname}/../miner/worker.js`) // Worker thread (for PoW mining).
let mined = false // This will be used to inform the node that another node has already mined before it.


// Some chain info cache
const chainInfo = {
    transactionPool: [],
    latestBlock: generateGenesisBlock(), 
    latestSyncBlock: null,
    checkedBlock: {},
    tempStates: {},
    difficulty: 1
}

const stateDB = new Level(__dirname + "/../log/stateStore", { valueEncoding: "json" })
const blockDB = new Level(__dirname + "/../log/blockStore", { valueEncoding: "json" })
const bhashDB = new Level(__dirname + "/../log/bhashStore")
const codeDB = new Level(__dirname + "/../log/codeStore")

const pino = require('pino')
const logger = pino({
  transport: {
    target: 'pino-pretty',
    options: {
      ignore: 'pid,hostname',
    },
  },
})

const fastify = require('fastify')({
  logger : logger
})

/**
 * Starts a node at a specified WS address.
 * */
async function startServer(options) 
{
    const PORT                 = options.PORT || 3000                        
    const RPC_PORT             = options.RPC_PORT || 5000                    
    const PEERS                = options.PEERS || []                         
    const MAX_PEERS            = options.MAX_PEERS || 10                      
    const MY_ADDRESS           = options.MY_ADDRESS || "ws://localhost:3000" 
    const ENABLE_MINING        = options.ENABLE_MINING ? true : false        
    const ENABLE_LOGGING       = options.ENABLE_LOGGING ? true : false       
    const ENABLE_RPC           = options.ENABLE_RPC ? true : false 
    const privateKey           = options.PRIVATE_KEY || ec.genKeyPair().getPrivate("hex")
    const keyPair              = ec.keyFromPrivate(privateKey, "hex")
    const publicKey            = keyPair.getPublic("hex")
    let   ENABLE_CHAIN_REQUEST = options.ENABLE_CHAIN_REQUEST ? true : false


    process.on("uncaughtException", err => fastify.log.error(err))
    await codeDB.put(EMPTY_HASH, "")

    const server = new WS.Server({ port: PORT })
    fastify.log.info(`Started WS server on PORT ${PORT.toString()}`)

    server.on("connection", async (socket, req) => 
    {
        /**
         * The message handler
         * */ 
        socket.on("message", async message => 
        {
            const _message = parseJSON(message) 
            switch (_message.type) 
            {
                case TYPE.NEW_BLOCK:
                    const newBlock = _message.data
                    if (!chainInfo.checkedBlock[newBlock.hash]) 
                    {
                        chainInfo.checkedBlock[newBlock.hash] = true
                    } 
                    else
                    { 
                        return 
                    }

                    if (
                        newBlock.parentHash !== chainInfo.latestBlock.parentHash &&
                        (!ENABLE_CHAIN_REQUEST || (ENABLE_CHAIN_REQUEST && currentSyncBlock > 1))
                    ) 
                    {
                        chainInfo.checkedBlock[newBlock.hash] = true
                        if (await verifyBlock(newBlock, chainInfo, stateDB, codeDB, ENABLE_LOGGING)) 
                        {
                            fastify.log.info("New block received.")
                            if (ENABLE_MINING) 
                            {
                                mined = true //check their chain length & sync if > your chain else mine
                                worker.kill() 
                                worker = fork(`${__dirname}/../miner/worker.js`) 
                            }
                            await updateDifficulty(newBlock, chainInfo, blockDB)
                            await blockDB.put(newBlock.blockNumber.toString(), newBlock)
                            await bhashDB.put(newBlock.hash, newBlock.blockNumber.toString())
                            chainInfo.latestBlock = newBlock
                            chainInfo.transactionPool = await clearDepreciatedTxns(chainInfo, stateDB)
                            fastify.log.info(`Block #${newBlock.blockNumber} synced, state transited.`)
                            sendMessage(message, opened)
                            if (ENABLE_CHAIN_REQUEST) //they perhaps just sent the latest block
                            {
                                ENABLE_CHAIN_REQUEST = false
                            }
                        }
                    }
                    break
                
                case TYPE.CREATE_TRANSACTION:
                    if (ENABLE_CHAIN_REQUEST) break 

                    const transaction = _message.data
                    if (!(await Transaction.isValid(transaction, stateDB))) break

                    const txSenderPubkey = Transaction.getPubKey(transaction)
                    const txSenderAddress = SHA256(txSenderPubkey)
                    if (!(await stateDB.keys().all()).includes(txSenderAddress)) break
                    let maxNonce = 0
                    for (const tx of chainInfo.transactionPool) 
                    {
                        const poolTxSenderPubkey = Transaction.getPubKey(transaction)
                        const poolTxSenderAddress = SHA256(poolTxSenderPubkey)
                        if (poolTxSenderAddress === txSenderAddress && tx.nonce > maxNonce) 
                        {
                            maxNonce = tx.nonce
                        }
                    }
                    if (maxNonce + 1 !== transaction.nonce) return
                    fastify.log.info("New transaction received, broadcasted and added to pool.")
                    chainInfo.transactionPool.push(transaction)
                    sendMessage(message, opened)
                    break

                case TYPE.REQUEST_BLOCK:
                    if (!ENABLE_CHAIN_REQUEST) 
                    {
                        const { blockNumber, requestAddress } = _message.data
                        const socket = opened.find(node => node.address === requestAddress).socket
                        const currentBlockNumber = Math.max(...(await blockDB.keys().all()).map(key => parseInt(key)))
                        if (blockNumber > 0 && blockNumber <= currentBlockNumber) 
                        {
                            const block = await blockDB.get( blockNumber.toString() )
                            socket.send(produceMessage(TYPE.SEND_BLOCK, block))
                            fastify.log.info(`Sent block #${blockNumber} to ${requestAddress}.`)
                        }
                    }
                    break
                
                case TYPE.SEND_BLOCK:
                    const block = _message.data
                    if (ENABLE_CHAIN_REQUEST && currentSyncBlock === block.blockNumber) 
                    {
                        if ( chainInfo.latestSyncBlock === null || await verifyBlock(block, chainInfo, stateDB, codeDB, ENABLE_LOGGING)) 
                        {
                            currentSyncBlock += 1
                            await blockDB.put(block.blockNumber.toString(), block)
                            await bhashDB.put(block.hash, block.blockNumber.toString())
                            if (!chainInfo.latestSyncBlock) 
                            {
                                chainInfo.latestSyncBlock = block  
                                await changeState(block, stateDB, codeDB, ENABLE_LOGGING)
                            }
                            chainInfo.latestBlock = block 
                            await updateDifficulty(block, chainInfo, blockDB) 
                            fastify.log.info(`Synced block #${block.blockNumber}`)

                            for (const node of opened) 
                            {
                                node.socket.send
                                (
                                    produceMessage
                                    (
                                        TYPE.REQUEST_BLOCK,
                                        { blockNumber: currentSyncBlock, requestAddress: MY_ADDRESS }
                                    )
                                )
                                await new Promise(r => setTimeout(r, 5000)) 
                            }
                        }
                    }
                    break
                
                case TYPE.HANDSHAKE:
                    const address = _message.data
                    if (connectedNodes <= MAX_PEERS) 
                    {
                        connect(MY_ADDRESS, address)
                    }
            }
        })
    })

    if (!ENABLE_CHAIN_REQUEST) {
        if ((await blockDB.keys().all()).length === 0) 
        {
            await stateDB.put(FIRST_ACCOUNT, { balance: INITIAL_SUPPLY, codeHash: EMPTY_HASH, nonce: 0, storageRoot: EMPTY_HASH })
            await blockDB.put(chainInfo.latestBlock.blockNumber.toString(), chainInfo.latestBlock)
            await bhashDB.put(chainInfo.latestBlock.hash, chainInfo.latestBlock.blockNumber.toString())
            await changeState(chainInfo.latestBlock, stateDB, codeDB)
        } else {
            chainInfo.latestBlock = await blockDB.get( Math.max(...(await blockDB.keys().all()).map(key => parseInt(key))).toString() )
            chainInfo.difficulty = chainInfo.latestBlock.difficulty
        }
    }

    PEERS.forEach(peer => connect(MY_ADDRESS, peer)) 
    let currentSyncBlock = 1
    if (ENABLE_CHAIN_REQUEST) 
    {
        const blockNumbers = await blockDB.keys().all()
        if (blockNumbers.length !== 0) 
        {
            currentSyncBlock = Math.max(...blockNumbers.map(key => parseInt(key)))
        }

        if (currentSyncBlock === 1) 
        {
            await stateDB.put(FIRST_ACCOUNT, { balance: INITIAL_SUPPLY, codeHash: EMPTY_HASH, nonce: 0, storageRoot: EMPTY_HASH })
        }

        setTimeout(async () => 
        {
            for (const node of opened) 
            {
                node.socket.send
                (
                    produceMessage
                    (
                        TYPE.REQUEST_BLOCK,
                        { blockNumber: currentSyncBlock, requestAddress: MY_ADDRESS }
                    )
                )

                await new Promise(r => setTimeout(r, 5000)) 
            }
        }, 5000)
    }

    if (ENABLE_MINING) loopMine(publicKey, ENABLE_CHAIN_REQUEST, ENABLE_LOGGING)
    if (ENABLE_RPC) rpc(RPC_PORT, { publicKey, mining: ENABLE_MINING }, sendTransaction, keyPair, stateDB, blockDB, bhashDB, codeDB)
}

/**
 * Connects to a WebSocket server at the specified address.
 * */
function connect(MY_ADDRESS, address) 
{
    /**
     * Check if the `address` is not already in the `connected` array and if it is not equal to `MY_ADDRESS`.
     * */
    if (!connected.find(peerAddress => peerAddress === address) && address !== MY_ADDRESS) 
    {
        const socket = new WS(address) 

        /**
         * Open a connection to the socket and send a handshake message to all connected nodes.
         * */
        socket.on("open", async () => {
            for (const _address of [MY_ADDRESS, ...connected]) socket.send(produceMessage(TYPE.HANDSHAKE, _address))
            for (const node of opened) node.socket.send(produceMessage(TYPE.HANDSHAKE, address))

            if (!opened.find(peer => peer.address === address) && address !== MY_ADDRESS) 
            {
                opened.push({ socket, address })
            }
            if (!connected.find(peerAddress => peerAddress === address) && address !== MY_ADDRESS) 
            {
                connected.push(address)
                connectedNodes++
                fastify.log.info(`Connected to ${address}.`)
                socket.on("close", () => {
                    opened.splice(connected.indexOf(address), 1)
                    fastify.log.info(`Disconnected from ${address}.`)
                })
            }
        })
    }
    return true
}

/**
 * Broadcasts a transaction to other nodes.
*/
async function sendTransaction(transaction) 
{
    sendMessage(produceMessage(TYPE.CREATE_TRANSACTION, transaction), opened)
    fastify.log.info("Sent one transaction.")
    await addTransaction(transaction, chainInfo, stateDB)
}

async function mine(publicKey, ENABLE_LOGGING) 
{
    function mine(block, difficulty) 
    {
        return new Promise((resolve, reject) => 
        {
            worker.addListener("message", message => resolve(message.result))
            worker.send({ type: "MINE", data: [block, difficulty] })
        })
    }

    // Create a new block.
    const block = new Block
    (
        chainInfo.latestBlock.blockNumber + 1, 
        Date.now(), 
        [], // Will add transactions down here 
        chainInfo.difficulty, 
        chainInfo.latestBlock.hash,
        SHA256(publicKey)
    )

    // Collect a list of transactions to mine
    const transactionsToMine = [], states = {}, code = {}, storage = {}, skipped = {}
    let totalContractGas = 0n, totalTxGas = 0n

    const existedAddresses = await stateDB.keys().all()

    for (const tx of chainInfo.transactionPool) {
        if (totalContractGas + BigInt(tx.additionalData.contractGas || 0) >= BigInt(BLOCK_GAS_LIMIT)) break

        const txSenderPubkey = Transaction.getPubKey(tx)
        const txSenderAddress = SHA256(txSenderPubkey)

        if (skipped[txSenderAddress]) continue // Check if transaction is from an ignored address.

        // Normal coin transfers
        if (!states[txSenderAddress]) {
            const senderState = await stateDB.get(txSenderAddress)

            states[txSenderAddress] = senderState
            code[senderState.codeHash] = await codeDB.get(senderState.codeHash)

            if (senderState.codeHash !== EMPTY_HASH) {
                skipped[txSenderAddress] = true
                continue
            }
    
            states[txSenderAddress].balance = (BigInt(senderState.balance) - BigInt(tx.amount) - BigInt(tx.gas) - BigInt(tx.additionalData.contractGas || 0)).toString()
        } else {
            if (states[txSenderAddress].codeHash !== EMPTY_HASH) {
                skipped[txSenderAddress] = true
                continue
            }

            states[txSenderAddress].balance = (BigInt(states[txSenderAddress].balance) - BigInt(tx.amount) - BigInt(tx.gas) - BigInt(tx.additionalData.contractGas || 0)).toString()
        }

        if (!existedAddresses.includes(tx.recipient) && !states[tx.recipient]) {
            states[tx.recipient] = { balance: "0", codeHash: EMPTY_HASH, nonce: 0, storageRoot: EMPTY_HASH }
            code[EMPTY_HASH] = ""
        }
    
        if (existedAddresses.includes(tx.recipient) && !states[tx.recipient]) {
            states[tx.recipient] = await stateDB.get(tx.recipient)
            code[states[tx.recipient].codeHash] = await codeDB.get(states[tx.recipient].codeHash)
        }
    
        states[tx.recipient].balance = (BigInt(states[tx.recipient].balance) + BigInt(tx.amount)).toString()

        // Contract deployment
        if (
            states[txSenderAddress].codeHash === EMPTY_HASH &&
            typeof tx.additionalData.scBody === "string"
        ) {
            states[txSenderAddress].codeHash = SHA256(tx.additionalData.scBody)
            code[states[txSenderAddress].codeHash] = tx.additionalData.scBody
        }

        // Update nonce
        states[txSenderAddress].nonce += 1

        // Decide to drop or add transaction to block
        if (BigInt(states[txSenderAddress].balance) < 0n) {
            skipped[txSenderAddress] = true
            continue
        } else {
            transactionsToMine.push(tx)

            totalContractGas += BigInt(tx.additionalData.contractGas || 0)
            totalTxGas += BigInt(tx.gas) + BigInt(tx.additionalData.contractGas || 0)
        }

        // Contract execution
        if (states[tx.recipient].codeHash !== EMPTY_HASH) {
            const contractInfo = { address: tx.recipient }
            
            const [ newState, newStorage ] = await drisscript(code[states[tx.recipient].codeHash], states, BigInt(tx.additionalData.contractGas || 0), stateDB, block, tx, contractInfo, false)

            for (const account of Object.keys(newState)) {
                states[account] = newState[account]

                storage[tx.recipient] = newStorage
            }
        }
    }

    block.transactions = transactionsToMine // Add transactions to block
    block.hash = Block.getHash(block) // Re-hash with new transactions
    block.txRoot = buildMerkleTree(indexTxns(block.transactions)).val // Re-gen transaction root with new transactions

    // Mine the block.
    mine(block, chainInfo.difficulty)
        .then(async result => {
            // If the block is not mined before, we will add it to our chain and broadcast this new block.
            if (!mined) {
                await updateDifficulty(result, chainInfo, blockDB) // Update difficulty

                await blockDB.put(result.blockNumber.toString(), result) // Add block to chain
                await bhashDB.put(result.hash, result.blockNumber.toString()) // Assign block number to the matching block hash

                chainInfo.latestBlock = result // Update chain info

                // Reward

                if (!existedAddresses.includes(result.coinbase) && !states[result.coinbase]) {
                    states[result.coinbase] = { balance: "0", codeHash: EMPTY_HASH, nonce: 0, storageRoot: EMPTY_HASH }
                    code[EMPTY_HASH] = ""
                }
            
                if (existedAddresses.includes(result.coinbase) && !states[result.coinbase]) {
                    states[result.coinbase] = await stateDB.get(result.coinbase)
                    code[states[result.coinbase].codeHash] = await codeDB.get(states[result.coinbase].codeHash)
                }

                let gas = 0n

                for (const tx of result.transactions) { gas += BigInt(tx.gas) + BigInt(tx.additionalData.contractGas || 0) }

                states[result.coinbase].balance = (BigInt(states[result.coinbase].balance) + BigInt(BLOCK_REWARD) + gas).toString()

                // Transit state
                for (const address in storage) {
                    const storageDB = new Level(__dirname + "/../log/accountStore/" + address)
                    const keys = Object.keys(storage[address])
        
                    states[address].storageRoot = buildMerkleTree(keys.map(key => key + " " + storage[address][key])).val
        
                    for (const key of keys) {
                        await storageDB.put(key, storage[address][key])
                    }
        
                    await storageDB.close()
                }
        
                for (const account of Object.keys(states)) {
                    await stateDB.put(account, states[account])
        
                    await codeDB.put(states[account].codeHash, code[states[account].codeHash])
                }

                // Update the new transaction pool (remove all the transactions that are no longer valid).
                chainInfo.transactionPool = await clearDepreciatedTxns(chainInfo, stateDB)

                sendMessage(produceMessage(TYPE.NEW_BLOCK, chainInfo.latestBlock), opened) // Broadcast the new block

                fastify.log.info(`Block #${chainInfo.latestBlock.blockNumber} mined and synced, state transited.`)
            } else {
                mined = false
            }

            // Re-create the worker thread
            worker.kill()

            worker = fork(`${__dirname}/../miner/worker.js`)
        })
        .catch(err => fastify.log.error(err))
}

function loopMine(publicKey, ENABLE_CHAIN_REQUEST, ENABLE_LOGGING, time = 10000) 
{
    let length = chainInfo.latestBlock.blockNumber
    let mining = true

    setInterval(async () => {
        if (mining || length !== chainInfo.latestBlock.blockNumber) 
        {
            mining = false
            length = chainInfo.latestBlock.blockNumber
            if (!ENABLE_CHAIN_REQUEST) await mine(publicKey, ENABLE_LOGGING)
        }
    }, time)
}

module.exports = { startServer }
