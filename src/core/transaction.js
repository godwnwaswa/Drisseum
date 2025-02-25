"use strict"

const BN = require("bn.js")
const { isNumber } = require("../utils/utils")
const crypto = require("crypto"), SHA256 = message => crypto.createHash("sha256").update(message).digest("hex")
const ec = new (require("elliptic").ec)("secp256k1")
const { EMPTY_HASH } = require("../config.json")

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
    logger: logger
})


class Transaction {
  constructor({ recipient = "", amount = "0", gas = '2000000000', additionalData = {}, nonce = 0 } = {}) {
  Object.assign(this, { recipient, amount, gas, additionalData, nonce, signature: {}, });
}


  static getHash(tx) {
    return SHA256(`${tx.recipient}${tx.amount}${tx.gas}${JSON.stringify(tx.additionalData)}${tx.nonce.toString()}`)
  }

  static sign(transaction, keyPair) {
    const sigObj = keyPair.sign(Transaction.getHash(transaction))
    Object.assign(transaction.signature, {
      v: sigObj.recoveryParam.toString(16),
      r: sigObj.r.toString(16),
      s: sigObj.s.toString(16),
    })
  }

  static getPubKey(tx) {
    const sigObj = {
      r: new BN(tx.signature.r, 16),
      s: new BN(tx.signature.s, 16),
      recoveryParam: parseInt(tx.signature.v, 16),
    }
    const txHash = Transaction.getHash(tx)
    const senderPubkey = ec.recoverPubKey(
      new BN(txHash, 16).toString(10),
      sigObj,
      ec.getKeyRecoveryParam(txHash, sigObj, ec.genKeyPair().getPublic())
    )
    return ec.keyFromPublic(senderPubkey).getPublic("hex")
  }

  static async isValid(tx, stateDB) {
    const { recipient, amount, gas, additionalData, nonce } = tx
    const { contractGas } = additionalData
    const response = {valid: false, msg: ''}
    //validate tx prop types
    if (
      !(
        typeof recipient === "string" && typeof amount === "string" &&
        typeof gas === "string" && typeof additionalData === "object" &&
        typeof nonce === "number" && isNumber(amount) && isNumber(gas) &&
        // contract gas is undefined for txns made to EOA
        (typeof contractGas === "undefined" || (typeof contractGas === "string" && isNumber(contractGas))) 
        
      )
    ) {
      response.msg = 'msg: Invalid prop types.'
      return response
    }
    const senderPubKey = Transaction.getPubKey(tx)
    const senderAddress = SHA256(senderPubKey)
    // sender is not part of the chain state
    if (!(await stateDB.keys().all()).includes(senderAddress)) {
      response.msg = 'msg: Sender not in state. hint: If you signed this tx, its contents have changed invalidating your sig.'
      return response
    }
    // stateDB tracks codeHash & balance
    const { balance, codeHash } = await stateDB.get(senderAddress)
    //EMPTY_HASH is set for every state object, !EMPTY_HASH executes a smart contract; 
    if (codeHash !== EMPTY_HASH) {
      response.msg = 'msg: Address is for a smart contract.'
      return response
    }
    if(BigInt(balance) < BigInt(amount) + BigInt(gas) + BigInt(contractGas || 0)){
      response.msg = 'msg: Insufficient balance.'
      return response
    }
    if(BigInt(gas) < 2000000000n){
      response.msg = 'msg: Insufficient gas fee.'
      return response
    }
    if(BigInt(amount) < 0){
      response.msg = 'msg: Min tx amount is 0.'
      return response
    }
    response.valid = true
    response.msg = 'msg: Valid Tx.'
    return response
  }
}

module.exports = Transaction
