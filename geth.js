const EthereumRpc = require('./ethereum-rpc');
const logger = require('debug')('etherscanner:geth');
const loggerError = require('debug')('etherscanner:error');
const pMap = require('p-map');
const BigNumber = require('bignumber.js');
const abiDecoder = require('abi-decoder');
const abiTether = require('@nova47sanz/etherscanner/abiContracts/tether')
const abiWocex = require('@nova47sanz/etherscanner/abiContracts/wocexBatchContracts')
const abisLoader = [];
class Geth {
  /**
   *
   * @param EthUrl
   */



  constructor(EthUrl) {

    this.eth = new EthereumRpc(EthUrl);
    abisLoader.push(abiTether);
    abisLoader.push(abiWocex);

  }

  async scanBlock(number) {
    const hexBlockNumber = '0x' + number.toString(16);
    const block = await this.eth.eth_getBlockByNumber('0x' + number.toString(16), false);
    if (!block) return [];
    const procTx = async txHash => {
      const result = await this.scanTransaction(txHash);
      const tx = await this.eth.eth_getTransactionByHash(txHash);

      tx.blockNumber = number;
      const receipt = await this.eth.eth_getTransactionReceipt(txHash);
      const isInternal = result.filter(t => t.isInternal);

      const toBalance = tx.to === null ? 0 : await this.eth.eth_getBalance(tx.to, hexBlockNumber);
      const fromBalance = await this.eth.eth_getBalance(tx.from, hexBlockNumber);
      let isContract = receipt.contractAddress !== null;
      if (tx.to !== null && !isContract) {
        //check if contract
        const code = await this.eth.eth_getCode(tx.to, hexBlockNumber);
        if (code.indexOf('0x') === 0) {
          isContract = true;
        }
      }
      const toAccount = {
        blockNumber: number,
        address: tx.to || 'none',
        balance: new BigNumber(this._getNumberFromHex(toBalance)).toString(10),
        timestamp: block.timestamp,
        isContract: isContract
      };
      const fromAccount = {
        blockNumber: number,
        address: tx.from,
        balance: new BigNumber(this._getNumberFromHex(fromBalance)).toString(10),
        timestamp: block.timestamp
      };
      const output = {
        hash: txHash,
        transaction: tx,
        scan: result,
        receipt: receipt,
        isInternal: isInternal.length > 0,
        toAccount,
        fromAccount
      };

      return output;
    };
    const results = await pMap(block.transactions, procTx, { concurrency: 8 });
    block.number = number;
    return { block, transactions: results };
  }
  async scanTransaction(hash, fullScan = false) {
    if (fullScan) {

    }
    const tx = await this.eth.eth_getTransactionByHash(hash);

    const calls = await this._getTransactionCalls(tx);
    return calls;
  }

  async scanTransactionDetails(tx) {
    const calls = await this._getTransactionCalls(tx);
    return calls;
  }
  async _getTransactionCalls(tx) {
    const result = await this._getTransactionsFromTrace(tx.hash, tx.blockNumber);
    return this._getTransactionsFromCall(tx, result);
  }

  async _processTransaction(txHash) {
    const transaction = await this.eth.eth_getTransactionByHash(txHash);
    const result = await this.scanTransactionDetails(transaction);

    const receipt = await this.eth.eth_getTransactionReceipt(txHash);
    const isInternal = result.filter(t => t.isInternal);
    const output = {
      hash: txHash,
      transaction: transaction,
      transfers: result,
      receipt: receipt,
      isInternal: isInternal.length > 0
    };
    return output;
  }

  async _processTransactionFromTx(tx) {

    const result = await this.scanTransaction(txHash);

    const receipt = await this.eth.eth_getTransactionReceipt(txHash);
    const isInternal = result.filter(t => t.isInternal);
    const output = {
      hash: txHash,
      transaction: tx,
      transfers: result,
      receipt: receipt,
      isInternal: isInternal.length > 0
    };
    return output;
  }
  _getTransactionsFromCall(tx, callObject, dex = -1, isInternal = false) {
    let txs = [];
    if (parseInt(callObject.value, 16) > 0) {
      txs.push({
        blockNumber: this._getNumberFromHex(tx.blockNumber),
        blockHash: tx.blockHash,
        to: this._getAddress(callObject.to),
        from: this._getAddress(callObject.from),
        value: new BigNumber(callObject.value).toString(),
        hash: tx.hash,
        type: callObject.type,
        isSuicide: callObject.type == 'SELFDESTRUCT',
        isInternal,
        traceAddress: dex
      });

    }
    else {
      if (callObject.calls != undefined) {
        console.log(tx.hash, 'has sub TXs');
        callObject.calls.forEach(_callObject => {
          if (_callObject.input.length > 139) {
            try {
              var to, from, value, name, decodedData= "";

              txs.push({
                blockNumber: '',
                blockHash: '',
                to: to,
                from: callObject.to,
                value: value,
                hash: tx.hash,
                type: 'Token',
                contract: _callObject.to,
                method: name,
                isSuicide: 'none',
                'isInternal': true,
                traceAddress: Math.abs(dex),
                input: _callObject.input,
                inputDecoded: decodedData
              });

            } catch (error) {
              console.error(error)
            }
          }
          dex++;
        });
      }
      else {
        if (callObject.type == "STATICCALL") {
          return;
        }
        try {
          console.log(tx.hash, 'is single');
          if (callObject == undefined || callObject.length == 0) {
            callObject = tx;
          }

          var to, from, value, name, decodedData = "";

          txs.push({
            blockNumber: this._getNumberFromHex(tx.blockNumber),
            blockHash: tx.blockHash,
            to: to,
            from: callObject.from,
            value: value,
            hash: tx.hash,
            type: 'Token',
            contract: callObject.to,
            method: name,
            isSuicide: 'none',
            'isInternal': true,
            traceAddress: Math.abs(dex),
            input: callObject.input,
            inputDecoded: decodedData
          });
        } catch (error) {
          console.error(error)
        }
      }
    }
    if (!callObject.calls) {
      return txs;
    }
    callObject.calls.forEach(_callObject => {
      dex++;
      txs = txs.concat(this._getTransactionsFromCall(tx, _callObject, dex, true));
    });
    return txs;
  }

  async _getTransactionsFromTrace(txHash, txBlockNumber) {

    try {
      const blockNumber = await this.eth.eth_blockNumber();

      const result = await this.eth.call('debug_traceTransaction', txHash, {
        tracer: 'callTracer',
        timeout: '30s',
        reexec: blockNumber - txBlockNumber + 20
      });
      return result;
    } catch (err) {
      loggerError('error doing trace', err);
      return [];
    }
  }
  _toHex(value) {
    return '0x' + value.toLowerCase().replace(/^0x/i, '');
  }
  _getAddress(value) {
    if (!value) return value;
    if (value.match(/^0x[a-zA-Z0-9]{40}/)) return value;

    if (typeof (value) == typeof (true)) return value ? '0x01' : '0x00';

    let address = this._toHex(value);
    while (address.length < 42) address = address.replace(/^0x/, '0x0');
    return address;
  }
  _getNumberFromHex(value) {
    if (!value) return value;
    if (value.match(/^0x[a-zA-Z0-9]{40}/)) return value;

    let num = value.replace(/^0x/, '0x0');
    return parseInt(num, 16);
  }
}

module.exports = Geth;

/**
 * @typedef {object} etherscannerObj
 * @property {String} hash
 * @property {String} from
 * @property {String} to
 * @property {Number} value
 * @property {Number} blockNumber
 * @property {String} blockHash
 * @property {Boolean} isInternal
 * @property {String} type
 */
