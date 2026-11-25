// Self-custody wallet creation. Runs in the BROWSER (bundled to public/vendor/walletkit.js):
// the recovery phrase is generated with crypto.getRandomValues and never sent to the server.
// Uses audited libraries (@scure/bip39, @scure/bip32, @noble/curves, @noble/hashes) - no hand-rolled key math.
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { bech32, base58, createBase58check } from '@scure/base';
import { ed25519 } from '@noble/curves/ed25519.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { toChecksumAddress } from './keccak.js';

// Standard paths, so the same phrase restores the same addresses in MetaMask/Rabby/Trust (BIP-44 ETH, also every
// EVM chain), Sparrow/Electrum/BlueWallet (BIP-84 BTC), Electrum-LTC (BIP-84 LTC), Dogecoin wallets (BIP-44 DOGE)
// and Phantom/Solflare (SLIP-10 SOL).
export const PATHS = { eth: "m/44'/60'/0'/0/0", btc: "m/84'/0'/0'/0/0", ltc: "m/84'/2'/0'/0/0", doge: "m/44'/3'/0'/0/0", sol: "m/44'/501'/0'/0'" };
const SOL_PATH = [44, 501, 0, 0]; // all hardened (ed25519 has no public derivation)
const H = 0x80000000;

/** SLIP-10 ed25519: hardened-only derivation; returns the 32-byte private key of the final node. */
export function slip10Ed25519(seed, path) {
  let I = hmac(sha512, new TextEncoder().encode('ed25519 seed'), seed);
  let key = I.slice(0, 32), chain = I.slice(32);
  for (const idx of path) {
    const data = new Uint8Array(37);
    data.set(key, 1);
    new DataView(data.buffer).setUint32(33, (idx | H) >>> 0);
    I.fill(0); I = hmac(sha512, chain, data); data.fill(0); key.fill(0); chain.fill(0);
    key = I.slice(0, 32); chain = I.slice(32);
  }
  I.fill(0); chain.fill(0);
  return key;
}

const normalize = (m) => String(m ?? '').normalize('NFKD').trim().toLowerCase().split(/\s+/).join(' ');
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

/** 24 words = 256 bits of entropy from the platform CSPRNG. */
export const newMnemonic = () => generateMnemonic(wordlist, 256);
export const isValidMnemonic = (m) => validateMnemonic(normalize(m), wordlist);
export const WORDLIST = wordlist;

/** Public addresses only; private keys are wiped from the HD nodes before returning. */
export function deriveAddresses(mnemonic, passphrase = '') {
  if (!isValidMnemonic(mnemonic)) throw new Error('Invalid recovery phrase (word or checksum error)');
  const seed = mnemonicToSeedSync(normalize(mnemonic), passphrase);
  const root = HDKey.fromMasterSeed(seed);
  const ethNode = root.derive(PATHS.eth), btcNode = root.derive(PATHS.btc), ltcNode = root.derive(PATHS.ltc), dogeNode = root.derive(PATHS.doge);
  let solKey = null;
  try {
    const uncompressed = secp256k1.getPublicKey(ethNode.privateKey, false); // 65 bytes: 0x04 || X || Y
    const eth = toChecksumAddress('0x' + hex(keccak_256(uncompressed.slice(1)).slice(-20)));
    const h160 = (n) => ripemd160(sha256(n.publicKey));
    const btc = bech32.encode('bc', [0, ...bech32.toWords(h160(btcNode))]);
    const ltc = bech32.encode('ltc', [0, ...bech32.toWords(h160(ltcNode))]);
    const doge = createBase58check(sha256).encode(Uint8Array.from([0x1e, ...h160(dogeNode)]));
    solKey = slip10Ed25519(seed, SOL_PATH);
    const sol = base58.encode(ed25519.getPublicKey(solKey));
    return { eth, btc, ltc, doge, sol, paths: PATHS };
  } finally {
    for (const n of [ethNode, btcNode, ltcNode, dogeNode, root]) n.wipePrivateData();
    solKey?.fill(0);
    seed.fill(0);
  }
}
