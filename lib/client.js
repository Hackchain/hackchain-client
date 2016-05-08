'use strict';

const assert = require('assert');
const url = require('url');
const http = require('http');
const https = require('https');
const util = require('util');
const Buffer = require('buffer').Buffer;

const pow = require('proof-of-work');
const BN = require('bn.js');
const OBuf = require('obuf');
const WBuf = require('wbuf');

const hackchain = require('hackchain-core');
const TX = hackchain.TX;

function Client(uri) {
  const parsed = url.parse(uri);

  this.host = parsed.hostname;
  this.module = parsed.scheme === 'http:' ? http : https;
  this.port = parsed.port || (parsed.scheme === 'http:' ? 80 : 443);
  this.agent = new this.module.Agent({
    port: this.port,
    host: this.host,
    servername: parsed.host
  });
  this.prefix = '/v1';

  this.version = hackchain.version;
}
exports.Client = Client;

Client.prototype.request = function request(method, headers, path, callback) {
  let once = false;
  const done = (err, data) => {
    if (once)
      return;
    once = true;

    callback(err, data);
  };

  const req = this.module.request({
    agent: this.agent,

    host: this.hostname,
    hostname: this.hostname,
    port: this.port,

    method: method,
    path: this.prefix + path,
    headers: util._extend({
      'User-Agent': 'hackchain/client_v' + this.version,
      'Content-Type': 'application/json'
    }, headers)
  }, (res) => {
    let chunks = '';
    res.on('data', (chunk) => {
      chunks += chunk;
    });
    res.once('end', () => {
      let data;
      try {
        data = JSON.parse(chunks);
      } catch (e) {
        return done(e);
      }

      if (data.error)
        return done(new Error(data.error));

      if (res.statusCode < 200 || res.statusCode >= 400)
        return callback(new Error('Client: statusCode ' + res.statusCode));

      done(null, data);
    });
  });

  req.once('error', done);

  return req;
};

Client.prototype.get = function get(path, callback) {
  this.request('GET', {}, path, callback).end();
};

Client.prototype.post = function post(path, headers, body, callback) {
  this.request('POST', headers, path, callback).end(JSON.stringify(body));
};

Client.prototype.parseEntity = function parseEntity(hex, cons, callback) {
  const raw = Buffer.from(hex, 'hex');
  const buf = new OBuf();
  buf.push(raw);

  let entity;
  try {
    entity = cons.parse(buf);
  } catch (e) {
    return callback(e);
  }

  return callback(null, entity);
};

Client.prototype.getBlock = function getBlock(hash, callback) {
  this.get('/block/' + hash, (err, data) => {
    if (err)
      return callback(err);

    this.parseEntity(data.block, hackchain.Block, callback);
  });
};

Client.prototype.getTX = function getTX(hash, callback) {
  this.get('/tx/' + hash, (err, data) => {
    if (err)
      return callback(err);

    this.parseEntity(data.tx, TX, callback);
  });
};

Client.prototype.spendTX = function spendTX(tx, nonce, callback) {
  const buf = new WBuf();
  tx.render(buf);
  const data = { tx: Buffer.concat(buf.render()).toString('hex') };

  const headers = {
    'X-Proof-Of-Work': nonce
  };

  this.post('/tx/' + tx.hash().toString('hex'), headers, data, (err, data) => {
    if (err)
      return callback(err);

    callback(null, tx);
  });
};

Client.prototype.parseTX = function parseTX(data, callback) {
  assert.equal(data.version, TX.version,
               'Client: version must be ' + TX.version);
  assert(Array.isArray(data.inputs), 'Client: `tx.inputs` must be an Array');
  assert(Array.isArray(data.outputs), 'Client: `tx.inputs` must be an Array');

  const tx = new TX();

  for (let i = 0; i < data.inputs.length; i++) {
    const input = data.inputs[i];
    assert(input && typeof input === 'object',
           'Client: `tx.inputs[]` must contain Objects');
    assert.equal(typeof input.hash, 'string',
                 'Client: `tx.inputs[].hash` must be a hex string');
    assert.equal(typeof input.index, 'number',
                 'Client: `tx.inputs[].number` must be a number');
    assert(Array.isArray(input.script),
           'Client: `tx.inputs[].script` must be an Array');

    const hash = Buffer.from(input.hash, 'hex');
    const index = input.index;
    const script = TX.Script.compileTextArray(input.script);

    tx.input(hash, index, script);
  }

  for (let i = 0; i < data.outputs.length; i++) {
    const output = data.outputs[i];
    assert(output && typeof output === 'object',
           'Client: `tx.outputs[]` must contain Objects');
    assert.equal(typeof output.value, 'string',
                 'Client: `tx.output[].value` must be a decimal string');
    assert(Array.isArray(output.script),
           'Client: `tx.outputs[].script` must be an Array');

    const value = new BN(output.value, 10);
    const script = TX.Script.compileTextArray(output.script);

    tx.output(value, script);
  }

  callback(null, tx);
};

Client.prototype.getInfo = function getInfo(callback) {
  this.get('/', callback);
};

Client.prototype.getLeaderboard = function getLeaderboard(limit, callback) {
  this.get(`/leaderboard?limit=${limit}`, callback);
};

Client.prototype.getComplexity = function getComplexity(callback) {
  this.getInfo((err, info) => {
    if (err)
      return callback(err);

    return callback(null, info['proof-of-work-complexity'] || 0);
  });
};

Client.prototype.getNonce = function getNonce(callback) {
  this.getComplexity((err, complexity) => {
    if (err)
      return callback(err);

    const solver = new pow.Solver();
    const nonce = solver.solve(complexity);

    callback(null, `${complexity}:${nonce.toString('hex')}`);
  });
};
