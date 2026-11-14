import {createHmac} from 'node:crypto';

export function adapterSignature(key:string,timestamp:string,nonce:string,body:string) {
  return createHmac('sha256',key).update(JSON.stringify(['qc-adapter-v1',timestamp,nonce,body])).digest('hex');
}
