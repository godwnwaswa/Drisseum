const EC = require("elliptic").ec, ec = new EC("secp256k1");
const crypto = require("crypto"), SHA256 = message => crypto.createHash("sha256").update(message).digest("hex");

const Block = require("./block");
const Transaction = require("./transaction");
const { FIRST_ACCOUNT } = require("../config.json");

/**
 * Generates the genesis block. Handles different configurations of the chain like ICO.
*/
function genesisBlock() {
    return new Block(1, Date.now(), [], 1, "", FIRST_ACCOUNT);
}

module.exports = genesisBlock;
