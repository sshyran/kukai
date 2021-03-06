import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { of } from 'rxjs/observable/of';
import { catchError } from 'rxjs/operators';
import { Observable } from 'rxjs/Observable';
import { Buffer } from 'buffer';
import * as libs from 'libsodium-wrappers';
import * as Bs58check from 'bs58check';
import * as bip39 from 'bip39';
import Big from 'big.js';

import { TranslateService } from '@ngx-translate/core';  // Multiple instances created ?

import { Constants } from '../constants';

import { ErrorHandlingPipe } from '../pipes/error-handling.pipe';

const httpOptions = {
  headers: new HttpHeaders({ 'Content-Type': 'application/json' })
};

export interface KeyPair {
  sk: string | null;
  pk: string | null;
  pkh: string;
}
@Injectable()
export class OperationService {
  CONSTANTS = new Constants();
  nodeURL = this.CONSTANTS.NET.NODE_URL;
  CHAIN_ID = this.CONSTANTS.NET.CHAIN_ID;
  prefix = {
    tz1: new Uint8Array([6, 161, 159]),
    tz2: new Uint8Array([6, 161, 161]),
    tz3: new Uint8Array([6, 161, 164]),
    edpk: new Uint8Array([13, 15, 37, 217]),
    edsk: new Uint8Array([43, 246, 78, 7]),
    edsig: new Uint8Array([9, 245, 205, 134, 18]),
    sig: new Uint8Array([4, 130, 43]),
    o: new Uint8Array([5, 116]),
    B: new Uint8Array([1, 52]),
    TZ: new Uint8Array([3, 99, 29]),
    KT: new Uint8Array([2, 90, 121])
  };
  microTez = new Big(1000000);
  constructor(
    private http: HttpClient,
    private translate: TranslateService,
    private errorHandlingPipe: ErrorHandlingPipe
  ) { }
  /*
    Returns an observable for the activation of an ICO identity
  */
  activate(pkh: string, secret: string): Observable<any> {
    return this.http.get(this.nodeURL + '/chains/main/blocks/head/hash', {})
      .flatMap((hash: any) => {
        const fop: any = {
          branch: hash,
          contents: [{
            kind: 'activate_account',
            pkh: pkh,
            secret: secret
          }]
        };
        return this.http.post(this.nodeURL + '/chains/main/blocks/head/helpers/forge/operations', fop)
          .flatMap((opbytes: any) => {
            this.decodeOpBytes(opbytes);
            const sopbytes: string = opbytes + Array(129).join('0');
            fop.protocol = this.CHAIN_ID;
            fop.signature = 'edsigtXomBKi5CTRf5cjATJWSyaRvhfYNHqSUGrn4SdbYRcGwQrUGjzEfQDTuqHhuA8b2d8NarZjz8TRf65WkpQmo423BtomS8Q';
            return this.http.post(this.nodeURL + '/chains/main/blocks/head/helpers/preapply/operations', [fop])
              .flatMap((parsed: any) => {
                return this.http.post(this.nodeURL + '/injection/operation',
                  JSON.stringify(sopbytes), httpOptions)
                  .flatMap((final: any) => {
                    return this.opCheck(final);
                  });
              });
          });
      }).pipe(catchError(err => this.errHandler(err)));
  }
  opCheck(final: any, newPkh: string = null): Observable<any> {
    if (typeof (final) === 'string' && final.length === 51) {
      return of(
        {
          success: true,
          payload: {
            opHash: final,
            newPkh: newPkh
          }
        });
    } else {
      return of(
        {
          success: false,
          payload: {
            opHash: null,
            msg: final
          }
        });
    }
  }
  /*
    Returns an observable for the origination of new accounts.
  */
  originate(pkh: string, amount: number, fee: number = 0, keys: KeyPair): Observable<any> {
    return this.http.get(this.nodeURL + '/chains/main/blocks/head/hash', {})
      .flatMap((hash: string) => {
        return this.http.get(this.nodeURL + '/chains/main/blocks/head/context/contracts/' + pkh + '/counter', {})
          .flatMap((actions: number) => {
            return this.http.get(this.nodeURL + '/chains/main/blocks/head/context/contracts/' + pkh + '/manager_key', {})
              .flatMap((manager: any) => {
                let counter: number = Number(actions);
                const fop: any = {
                  branch: hash,
                  contents: [
                    {
                      kind: 'origination',
                      source: pkh,
                      fee: this.microTez.times(fee).toString(),
                      counter: (++counter).toString(),
                      gas_limit: '10100',
                      storage_limit: '277',
                      manager_pubkey: keys.pkh,
                      balance: this.microTez.times(amount).toString(),
                      spendable: true,
                      delegatable: true
                    }
                  ]
                };
                if (manager.key === undefined) {
                  fop.contents[1] = fop.contents[0];
                  fop.contents[0] = {
                    kind: 'reveal',
                    source: pkh,
                    fee: '0',
                    counter: (counter).toString(),
                    gas_limit: '10000',
                    storage_limit: '0',
                    public_key: keys.pk
                  };
                  fop.contents[1].counter = (Number(fop.contents[1].counter) + 1).toString();
                }
                return this.operation(fop, keys, true);
              });
          });
      }).pipe(catchError(err => this.errHandler(err)));
  }
  /*
    Returns an observable for the transaction of tez.
  */
  // transfer(from: string, to: string, amount: number, fee: number = 0, keys: KeyPair): Observable<any> {
  transfer(from: string, transactions: any, fee: number = 0, keys: KeyPair, gasLimit: number, storageLimit: number): Observable<any> {
    return this.http.get(this.nodeURL + '/chains/main/blocks/head/hash', {})
      .flatMap((hash: any) => {
        return this.http.get(this.nodeURL + '/chains/main/blocks/head/context/contracts/' + from + '/counter', {})
          .flatMap((actions: any) => {
            return this.http.get(this.nodeURL + '/chains/main/blocks/head/context/contracts/' + from + '/manager_key', {})
              .flatMap((manager: any) => {
                let counter: number = Number(actions);
                const fop: any = {
                  branch: hash,
                  contents: []
                };
                if (manager.key === undefined) { // Reveal
                  fop.contents.push({
                    kind: 'reveal',
                    source: from,
                    fee: '0',
                    counter: (++counter).toString(),
                    gas_limit: '10000',
                    storage_limit: '0',
                    public_key: keys.pk
                  });
                }
                for (let i = 0; i < transactions.length; i++) { // Transfers
                  fop.contents.push({
                    kind: 'transaction',
                    source: from,
                    fee: this.microTez.times(fee).toString(),
                    counter: (++counter).toString(),
                    gas_limit: gasLimit.toString(),
                    storage_limit: storageLimit.toString(),
                    amount: this.microTez.times(transactions[i].amount).toString(),
                    destination: transactions[i].to,
                  });
                }
                return this.operation(fop, keys);
              });
          });
      }).pipe(catchError(err => this.errHandler(err)));
  }
  /*
    Returns an observable for the delegation of baking rights.
  */
  delegate(from: string, to: string, fee: number = 0, keys: KeyPair): Observable<any> {
    return this.http.get(this.nodeURL + '/chains/main/blocks/head/hash', {})
      .flatMap((hash: any) => {
        return this.http.get(this.nodeURL + '/chains/main/blocks/head/context/contracts/' + from + '/counter', {})
          .flatMap((actions: any) => {
            return this.http.get(this.nodeURL + '/chains/main/blocks/head/context/contracts/' + from + '/manager_key', {})
              .flatMap((manager: any) => {
                let counter: number = Number(actions);
                const fop: any = {
                  branch: hash,
                  contents: [
                    {
                      kind: 'delegation',
                      source: from,
                      fee: this.microTez.times(fee).toString(),
                      counter: (++counter).toString(),
                      gas_limit: '10000',
                      storage_limit: '0',
                    }
                  ]
                };
                if (to !== '') {
                  fop.contents[0].delegate = to;
                }
                if (manager.key === undefined) {
                  fop.contents[1] = fop.contents[0];
                  fop.contents[0] = {
                    kind: 'reveal',
                    source: from,
                    fee: '0',
                    counter: (counter).toString(),
                    gas_limit: '10000',
                    storage_limit: '0', // '60000',
                    public_key: keys.pk
                  };
                  fop.contents[1].counter = (Number(fop.contents[1].counter) + 1).toString();
                }
                return this.operation(fop, keys);
              });
          });
      }).pipe(catchError(err => this.errHandler(err)));
  }
  /*
  Help function for operations
*/
  operation(fop: any, keys: KeyPair, origination: boolean = false): Observable<any> {
    console.log('fop to send: ' + JSON.stringify(fop));
    return this.http.post(this.nodeURL + '/chains/main/blocks/head/helpers/forge/operations', fop)
      .flatMap((opbytes: any) => {
        if (!this.validOpBytes(fop, opbytes)) {
          throw new Error('ValidationError');
        }
        if (!keys.sk) { // If sk doesn't exist, return unsigned operation
          return of(
            {
              success: true,
              payload: {
                unsignedOperation: opbytes
              }
            });
        } else { // If sk exists, sign and broadcast operation
          const signed = this.sign(opbytes, keys.sk);
          const sopbytes = signed.sbytes;
          const opHash = this.b58cencode(libs.crypto_generichash(32, this.hex2buf(sopbytes)), this.prefix.o);
          fop.protocol = this.CHAIN_ID;
          fop.signature = signed.edsig;
          return this.http.post(this.nodeURL + '/chains/main/blocks/head/helpers/preapply/operations', [fop])
            .flatMap((applied: any) => {
              console.log('applied: ' + JSON.stringify(applied));
              this.checkApplied(applied);
              console.log('sop: ' + sopbytes);
              return this.http.post(this.nodeURL + '/injection/operation', JSON.stringify(sopbytes), httpOptions)
                .flatMap((final: any) => {
                  let newPkh = null;
                  if (origination) {
                    newPkh = applied[0].contents[fop.contents.length - 1].
                      metadata.operation_result.originated_contracts[0];
                  }
                  return this.opCheck(final, newPkh);
                });
            });
        }
      });
  }
  /*
    Broadcast a signed operation to the network
  */
  broadcast(sopbytes: string): Observable<any> {
    let fop: any;
    try {
      const opbytes = sopbytes.slice(0, sopbytes.length - 128);
      const edsig = this.sig2edsig(sopbytes.slice(sopbytes.length - 128));
      fop = this.decodeOpBytes(opbytes);
      fop.protocol = this.CHAIN_ID;
      fop.signature = edsig;
    } catch (e) {
      return this.errHandler('Invalid bytes');
    }
    return this.http.post(this.nodeURL + '/chains/main/blocks/head/helpers/preapply/operations', [fop])
      .flatMap((parsed: any) => {
        let newPkh = null;
        for (let i = 0; i < parsed[0].contents.length; i++) {
          if (parsed[0].contents[i].kind === 'origination') {
            newPkh = parsed[0].contents[i].metadata.operation_result.originated_contracts[0];
          }
        }
        return this.http.post(this.nodeURL + '/injection/operation', JSON.stringify(sopbytes), httpOptions)
          .flatMap((final: any) => {
            return this.opCheck(final, newPkh);
          });
      }).pipe(catchError(err => this.errHandler(err)));
  }
  checkApplied(applied: any) {
    for (let i = 0; i < applied[0].contents.length; i++) {
      if (applied[0].contents[i].metadata.operation_result.status !== 'applied') {
        console.log('throw error ->');
        throw new Error(applied[0].contents[i].metadata.operation_result.errors[0].id); // prevent failed operations
      }
    }
  }
  errHandler(error: any): Observable<any> {
    if (error.error && error.error[0] && error.error[0].id) {
      console.log('found 2: ');
      const errorId = error.error[0].id;
      const errorMsg = this.errorHandlingPipe.transform(errorId);
      error = errorMsg;
    } else if (error.error && error.error[0] && error.error[0].error) {
      console.log('found 3: ');
      error = error.error[0].error;
    } else if (error.statusText) {
      console.log('found 4: ');
      error = error.statusText;
    } if (error.message) {
      console.log('found: ' + error.message);
      error = this.errorHandlingPipe.transform(error.message);
    } else {
      console.log('Error not categorized');
      console.log(JSON.stringify(error));
    }
    return of(
      {
        success: false,
        payload: {
          msg: error
        }
      }
    );
  }
  getBalance(pkh: string): Observable<any> {
    return this.http.get(this.nodeURL + '/chains/main/blocks/head/context/contracts/' + pkh + '/balance')
      .flatMap((balance: any) => {
        return of(
          {
            success: true,
            payload: {
              balance: balance
            }
          }
        );
      }).pipe(catchError(err => this.errHandler(err)));
  }
  getDelegate(pkh: string): Observable<any> {
    console.log('<Looking for delegate>');
    return this.http.get(this.nodeURL + '/chains/main/blocks/head/context/contracts/' + pkh)
      .flatMap((contract: any) => {
        let delegate = '';
        if (contract.delegate.value) {
          delegate = contract.delegate.value;
        }
        return of(
          {
            success: true,
            payload: {
              delegate: delegate
            }
          }
        );
      }).pipe(catchError(err => this.errHandler(err)));
  }
  getVotingRights(): Observable<any> {
    console.log('<Looking for voting rights>');
    return this.http.get(this.nodeURL + '/chains/main/blocks/head/votes/listings')
      .flatMap((listings: any) => {
        return of(
          {
            success: true,
            payload: listings
          }
        );
      }).pipe(catchError(err => this.errHandler(err)));
  }
  isRevealed(pkh: string): Observable<boolean> {
    return this.http.get(this.nodeURL + '/chains/main/blocks/head/context/contracts/' + pkh + '/manager_key', {})
      .flatMap((manager: any) => {
        if (manager.key === undefined) {
          return of(false);
        } else {
          return of(true);
        }
      }
      ).pipe(catchError(err => {
        return of(true);
      })); // conservative action
  }
  getAccount(pkh: string): Observable<any> {
    return this.http.get(this.nodeURL + '/chains/main/blocks/head/context/contracts/' + pkh)
      .flatMap((contract: any) => {
        let delegate = '';
        if (contract.delegate.value) {
          delegate = contract.delegate.value;
        }
        return of(
          {
            success: true,
            payload: {
              balance: contract.balance,
              manager: contract.manager,
              delegate: delegate,
              counter: contract.counter
            }
          }
        );
      }).pipe(catchError(err => this.errHandler(err)));
  }
  getManagerKey(pkh: string): Observable<string> {
    return this.http.get(this.nodeURL + '/chains/main/blocks/head/context/contracts/' + pkh + '/manager_key', {})
      .flatMap((manager: any) => {
        if (manager.key) {
          return of(manager.key);
        } else {
          return of('');
        }
      });
  }
  getVerifiedOpBytes(operationLevel, operationHash, pkh, pk): Observable<string> {
    return this.http.get(this.nodeURL + '/chains/main/blocks/' + operationLevel + '/operation_hashes/3', {})
      .flatMap((opHashes: any) => {
        const opIndex = opHashes.findIndex(a => a === operationHash);
        return this.http.get(this.nodeURL + '/chains/main/blocks/' + operationLevel + '/operations/3/' + opIndex, {})
          .flatMap((op: any) => {
            let ans = '';
            const sig = op.signature;
            delete op.chain_id;
            delete op.signature;
            delete op.hash;
            delete op.protocol;
            for (let i = 0; i < op.contents.length; i++) {
              delete op.contents[i].metadata;
              if (op.contents[i].managerPubkey) { // Fix for mainnet
                op.contents[i].manager_pubkey = op.contents[i].managerPubkey;
                delete op.contents[i].managerPubkey;
              }
            }
            console.log('DUMP: ' + JSON.stringify(op));
            return this.http.post(this.nodeURL + '/chains/main/blocks/head/helpers/forge/operations', op)
              .flatMap((opBytes: any) => {
                if (this.pk2pkh(pk) === pkh) {
                  if (this.verify(opBytes, sig, pk)) {
                    ans = opBytes + this.buf2hex(this.b58cdecode(sig, this.prefix.sig));
                  } else {
                    throw new Error('InvalidSignature');
                  }
                } else {
                  throw new Error('InvalidPublicKey');
                }
                return of(ans);
              });
          });
      });
  }
  createKTaddress(sopBytes: string): string {
    const hash = libs.crypto_generichash(32, this.hex2buf(sopBytes));
    const index = new Uint8Array([0, 0, 0, 0]);
    const hash2 = libs.crypto_generichash(20, this.mergebuf(index, hash));
    console.log('Calculated KT address ' + this.b58cencode(hash2, this.prefix.KT));
    return this.b58cencode(hash2, this.prefix.KT);
  }
  getConstants(): Observable<any> {
    return this.http.get(this.nodeURL + '/chains/main/blocks/head/context/constants');
  }
  seed2keyPair(seed: string): KeyPair {
    if (!seed) {
      throw new Error('NullSeed');
    }
    const keyPair = libs.crypto_sign_seed_keypair(seed);
    return {
      sk: this.b58cencode(keyPair.privateKey, this.prefix.edsk),
      pk: this.b58cencode(keyPair.publicKey, this.prefix.edpk),
      pkh: this.b58cencode(libs.crypto_generichash(20, keyPair.publicKey), this.prefix.tz1)
    };
  }
  mnemonic2seed(mnemonic: string, passphrase: string = '') {
    if (!this.validMnemonic(mnemonic)) {
      throw new Error('InvalidMnemonic');
    }
    return bip39.mnemonicToSeed(mnemonic, passphrase).slice(0, 32);
  }
  validMnemonic(mnemonic: string) {
    return bip39.validateMnemonic(mnemonic);
  }
  validAddress(address: string) {
    try {
      this.b58cdecode(address, this.prefix.tz1);
      return true;
    } catch (e) {
      return false;
    }
  }
  generateMnemonic(): string {
    return bip39.generateMnemonic(160);
  }
  pk2pkh(pk: string): string {
    const pkDecoded = this.b58cdecode(pk, this.prefix.edpk);
    return this.b58cencode(libs.crypto_generichash(20, pkDecoded), this.prefix.tz1);
  }
  hex2buf(hex) {
    return new Uint8Array(hex.match(/[\da-f]{2}/gi).map(function (h) {
      return parseInt(h, 16);
    }));
  }
  buf2hex(buffer) {
    const byteArray = new Uint8Array(buffer), hexParts = [];
    for (let i = 0; i < byteArray.length; i++) {
      const hex = byteArray[i].toString(16);
      const paddedHex = ('00' + hex).slice(-2);
      hexParts.push(paddedHex);
    }
    return hexParts.join('');
  }
  b58cencode(payload: any, prefixx?: Uint8Array) {
    const n = new Uint8Array(prefixx.length + payload.length);
    n.set(prefixx);
    n.set(payload, prefixx.length);
    return Bs58check.encode(new Buffer(this.buf2hex(n), 'hex'));
  }
  b58cdecode(enc, prefixx) {
    let n = Bs58check.decode(enc);
    n = n.slice(prefixx.length);
    return n;
  }
  mergebuf(b, wm = new Uint8Array([3])) {
    const r = new Uint8Array(wm.length + b.length);
    r.set(wm);
    r.set(b, wm.length);
    return r;
  }
  sign(bytes, sk): any {
    const hash = libs.crypto_generichash(32, this.mergebuf(this.hex2buf(bytes)));
    const sig = libs.crypto_sign_detached(hash, this.b58cdecode(sk, this.prefix.edsk), 'uint8array');
    const edsig = this.b58cencode(sig, this.prefix.edsig);
    const sbytes = bytes + this.buf2hex(sig);
    return {
      bytes: bytes,
      sig: sig,
      edsig: edsig,
      sbytes: sbytes,
    };
  }
  verify(bytes: string, sig: string, pk: string): Boolean {
    const hash = libs.crypto_generichash(32, this.mergebuf(this.hex2buf(bytes)));
    const signature = this.b58cdecode(sig, this.prefix.sig);
    const publicKey = this.b58cdecode(pk, this.prefix.edpk);
    return libs.crypto_sign_verify_detached(signature, hash, publicKey);
  }
  sig2edsig(sig: string): any {
    return this.b58cencode(this.hex2buf(sig), this.prefix.edsig);
  }
  /*
    Binary decoding
  */
  decodeOpBytes(opbytes: string) {
    // First 32 bytes = branch
    const branch = this.b58cencode(this.hex2buf(opbytes.slice(0, 64)), this.prefix.B);
    const contents = this.decodeContents(opbytes.slice(64));
    return {
      branch: branch,
      contents: contents
    };
  }
  decodeContents(content: string): any {
    // Check tag
    const tag = Number(this.hex2buf(content.slice(0, 2)));
    console.log('tag: ' + tag);
    switch (tag) {
      case 4: {
        return this.decodeActivateAccount(content.slice(2));
      } case 7: {
        return this.decodeReveal(content.slice(2));
      } case 8: {
        return this.decodeTransaction(content.slice(2));
      } case 9: {
        return this.decodeOrigination(content.slice(2));
      } case 10: {
        return this.decodeDelegation(content.slice(2));
      } default: {
        console.log('content: ' + content);
        throw new Error('Unknown tag');
      }
    }
  }
  decodeActivateAccount(content: any): any { // Tag 4
    const data: any = { kind: 'activate' };
    data.pkh = this.b58cencode(this.hex2buf(content.slice(0, 40)), this.prefix.tz1);
    data.secret = content.slice(40, 80);
    return data;
  }
  decodeReveal(content: any): any { // Tag 7
    let index = 0;
    const op = this.decodeCommon({ kind: 'reveal' }, content);
    if (op.rest.slice(index, index += 2) !== '00') {
      throw new Error('TagErrorR1');
    }
    op.data.public_key = this.b58cencode(this.hex2buf(op.rest.slice(index, index += 64)), this.prefix.edpk);
    if (op.rest.length === index) {
      return [op.data];
    } else {
      return [op.data].concat(this.decodeContents(op.rest.slice(index)));
    }
  }
  decodeTransaction(content: any): any { // Tag 8
    let index = 0;
    const op = this.decodeCommon({ kind: 'transaction' }, content);
    const amount = this.zarithDecode(op.rest.slice(index));
    op.data.amount = amount.value.toString();
    op.data.destination = this.decodeContractId(op.rest.slice(index += amount.count * 2, index += 44));
    if (op.rest.slice(index, index += 2) === 'ff') { // parameters?
      console.log('parameters ' + op.rest.slice(index - 2));
      throw new Error('UnsupportedTagT1');
    }
    if (op.rest.length === index) {
      return [op.data];
    } else {
      return [op.data].concat(this.decodeContents(op.rest.slice(index)));
    }
  }
  decodeOrigination(content: any): any { // Tag 9
    let index = 0;
    const op = this.decodeCommon({ kind: 'origination' }, content);
    // op.data.managerPubkey = this.decodePkh(op.rest.slice(index, index += 42));  // mainnet
    op.data.manager_pubkey = this.decodePkh(op.rest.slice(index, index += 42));  // zeronet
    const balance = this.zarithDecode(op.rest.slice(index));
    op.data.balance = balance.value.toString();
    op.data.spendable = (op.rest.slice(index += balance.count * 2, index += 2) === 'ff');
    op.data.delegatable = (op.rest.slice(index, index += 2) === 'ff');
    if (op.rest.slice(index, index += 2) === 'ff') { // delegate?
      console.log('delegate ' + op.rest.slice(index - 2));
      throw new Error('UnsupportedTagO1');
    }
    if (op.rest.slice(index, index += 2) === 'ff') { // script?
      console.log('script ' + op.rest.slice(index - 2));
      throw new Error('UnsupportedTagO2');
    }
    if (op.rest.length === index) {
      return [op.data];
    } else {
      return [op.data].concat(this.decodeContents(op.rest.slice(index)));
    }
  }
  decodeDelegation(content: any): any { // Tag 10
    let index = 0;
    const op = this.decodeCommon({ kind: 'delegation' }, content);
    console.log('hex: ' + op.rest + ' ' + op.rest.length);
    if (op.rest.slice(index, index += 2) === 'ff') {
      op.data.delegate = this.decodePkh(op.rest.slice(index, index += 42));
    } else if (op.rest.slice(index - 2, index) !== '00') {
      throw new Error('TagErrorD1');
    }
    console.log('INDEX' + index);
    if (op.rest.length === index) {
      return [op.data];
    } else {
      return [op.data].concat(this.decodeContents(op.rest.slice(index)));
    }
  }
  decodeCommon(data: any, content: any): any {
    let index = 0;
    data.source = this.decodeContractId(content.slice(index, index += 44));
    const fee = this.zarithDecode(content.slice(index));
    data.fee = fee.value.toString();
    const counter = this.zarithDecode(content.slice(index += fee.count * 2));
    data.counter = counter.value.toString();
    const gas_limit = this.zarithDecode(content.slice(index += counter.count * 2));
    data.gas_limit = gas_limit.value.toString();
    const storage_limit = this.zarithDecode(content.slice(index += gas_limit.count * 2));
    data.storage_limit = storage_limit.value.toString();
    const rest = content.slice(index += storage_limit.count * 2);
    return {
      data: data,
      rest: rest
    };
  }
  decodePkh(bytes: string): string {
    console.log('Pkh tag: ' + bytes.slice(0, 2));
    if (bytes.slice(0, 2) === '00') {
      return this.b58cencode(this.hex2buf(bytes.slice(2, 42)), this.prefix.tz1);
    } else if (bytes.slice(0, 2) === '01') {
      return this.b58cencode(this.hex2buf(bytes.slice(2, 42)), this.prefix.tz2);
    } else if (bytes.slice(0, 2) === '02') {
      return this.b58cencode(this.hex2buf(bytes.slice(2, 42)), this.prefix.tz3);
    } else {
      throw new Error('TagErrorPkh');
    }
  }
  decodePk() {
    return null;
  }
  zarithDecode(hex: string): any {
    console.log('hex ' + hex);
    let count = 0;
    let value = 0;
    while (1) {
      const byte = Number('0x' + hex.slice(0 + count * 2, 2 + count * 2));
      value += ((byte & 127) * (128 ** count));
      count++;
      if ((byte & 128) !== 128) {
        break;
      }
    }
    return {
      value: value,
      count: count
    };
  }
  decodeContractId(hex: string): string {
    if (hex.slice(0, 2) === '00') {
      return this.decodePkh(hex.slice(2, 44));
    } else if (hex.slice(0, 2) === '01') {
      return this.b58cencode(this.hex2buf(hex.slice(2, 42)), this.prefix.KT);
    } else {
      throw new Error('TagError');
    }
  }
  /*
    Validate operation bytes
  */
  validOpBytes(fop: any, opbytes: string): boolean {
    const fop2: any = this.decodeOpBytes(opbytes);
    if (JSON.stringify(fop) === JSON.stringify(fop2)) {
      return true; // Client and node agree the opbytes are correct!
    }
    return false;
  }
  /*
    Output
  */
  fop2strings(fop: any): any {
    const output: string[] = [];
    for (let i = 0; i < fop.contents.length; i++) {
      if (fop.contents[i].kind !== 'reveal') {
        let typeTmp = '';
        let sourceTmp = '';
        typeTmp = this.translate.instant('OPERATIONSERVICE.TYPE');
        sourceTmp = this.translate.instant('OPERATIONSERVICE.SOURCE');
        output.push(typeTmp + ' ' + fop.contents[i].kind);
        output.push(sourceTmp + ' ' + fop.contents[i].source);
        if (fop.contents[i].kind === 'transaction') {
          let destinationTmp = '';
          let amountTmp = '';
          destinationTmp = this.translate.instant('OPERATIONSERVICE.DESTINATION');
          amountTmp = this.translate.instant('OPERATIONSERVICE.AMOUNT');
          output.push(destinationTmp + ' ' + fop.contents[i].destination);
          output.push(amountTmp + ' ' + Big(Number(fop.contents[i].amount)).div(this.microTez).toString() + ' tez');
        } else if (fop.contents[i].kind === 'origination') {
          let managerTmp = '';
          let balanceTmp = '';
          managerTmp = this.translate.instant('OPERATIONSERVICE.MANAGER');
          balanceTmp = this.translate.instant('OPERATIONSERVICE.BALANCE');
          // output.push(managerTmp + ' ' + fop.contents[i].managerPubkey);  // betanet
          output.push(managerTmp + ' ' + fop.contents[i].manager_pubkey);  // zeronet
          output.push(balanceTmp + ' ' + Big(Number(fop.contents[i].balance)).div(this.microTez).toString() + ' tez');
        } else if (fop.contents[i].kind === 'delegation') {
          let delegateTmp = '';
          delegateTmp = this.translate.instant('OPERATIONSERVICE.DELEGATE');
          output.push(delegateTmp + ' ' + fop.contents[i].delegate);
          // output.push('Delegate: ' + fop.contents[i].delegate);
        } else {
          let tagNotSupportedTmp = '';
          tagNotSupportedTmp = this.translate.instant('OPERATIONSERVICE.TAGNOTSUPPORTED');
          throw new Error(tagNotSupportedTmp);
        }

        let feeTmp = '';
        feeTmp = this.translate.instant('OPERATIONSERVICE.FEE');
        output.push(feeTmp + ' ' + Big(Number(fop.contents[i].fee)).div(this.microTez).toString() + ' tez');
        if (i + 1 < fop.contents.length) {
          output.push('');
        }
      }
    }
    return output;
  }
}
