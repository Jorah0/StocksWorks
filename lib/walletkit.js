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
import { bech32 } from '@scure/base';
import { toChecksumAddress } from './keccak.js';

// Standard paths, so the same phrase restores the same addresses in MetaMask/Rabby/Trust (BIP-44 ETH)
// and Sparrow/Electrum/BlueWallet (BIP-84 native SegWit BTC).
export const PATHS = { eth: "m/44'/60'/0'/0/0", btc: "m/84'/0'/0'/0/0" };

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
  const ethNode = root.derive(PATHS.eth), btcNode = root.derive(PATHS.btc);
  try {
    const uncompressed = secp256k1.getPublicKey(ethNode.privateKey, false); // 65 bytes: 0x04 || X || Y
    const eth = toChecksumAddress('0x' + hex(keccak_256(uncompressed.slice(1)).slice(-20)));
    const btc = bech32.encode('bc', [0, ...bech32.toWords(ripemd160(sha256(btcNode.publicKey)))]);
    return { eth, btc, paths: PATHS };
  } finally {
    for (const n of [ethNode, btcNode, root]) n.wipePrivateData();
    seed.fill(0);
  }
}
