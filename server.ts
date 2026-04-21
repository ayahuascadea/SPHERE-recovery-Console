import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import net from 'net';
import BitcoinCore from 'bitcoin-core';
import dotenv from 'dotenv';
import * as bitcoin from 'bitcoinjs-lib';

dotenv.config();

// Robust path resolution for both ESM and CJS (bundled)
const getDirname = () => {
  return process.cwd();
};
const __dirname = getDirname();

import fs from 'fs';

// Helper to save found wallets to disk immediately
async function saveFoundWallet(phrase: string, address: string, balance: number, type: string) {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] FOUND! Balance: ${balance / 1e8} BTC | Type: ${type}\nPhrase: ${phrase}\nAddress: ${address}\n----------------------------------\n`;
  try {
    fs.appendFileSync(path.join(process.cwd(), 'found_wallets.txt'), entry);
    console.log(`\x1b[32m[SAVED] Found wallet recorded to found_wallets.txt!\x1b[0m`);
  } catch (e: any) {
    console.error(`[Error] Could not save found wallet: ${e.message}`);
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Bitcoin Core Client
  const btcClient = new (BitcoinCore as any)({
    host: process.env.BTC_RPC_HOST || '127.0.0.1',
    port: parseInt(process.env.BTC_RPC_PORT || '8332'),
    username: process.env.BTC_RPC_USER,
    password: process.env.BTC_RPC_PASS,
    network: 'mainnet'
  });

  // --- API Routes ---

  // Batch Balance Check (Electrum)
  app.post('/api/check-balances', async (req, res) => {
    const { addresses, provider = 'electrum', phraseMap = {} } = req.body;
    
    if (!addresses || !Array.isArray(addresses)) {
      return res.status(400).json({ error: 'Addresses array required' });
    }

    if (provider === 'electrum') {
      const host = process.env.ELECTRUM_HOST || '127.0.0.1';
      const port = parseInt(process.env.ELECTRUM_PORT || '50001');

      try {
        console.log(`[Electrum] Batch checking ${addresses.length} addresses via single connection...`);
        const balances = await getElectrumBalancesBatch(host, port, addresses);
        
        const results: Record<string, number> = {};
        balances.forEach((balance, index) => {
          const addr = addresses[index];
          results[addr] = balance;
          
          if (balance > 0) {
            const phrase = phraseMap[addr] || 'Unknown';
            saveFoundWallet(phrase, addr, balance, 'Electrum/Local');
          }
        });

        return res.json({ balances: results });
      } catch (e: any) {
        console.error(`[Electrum] Batch Error: ${e.message}`);
        return res.status(500).json({ error: 'Electrum Batch Error: ' + e.message });
      }
    } else {
      return res.status(501).json({ error: 'Provider not implemented' });
    }
  });

  // Helper for Batch Electrum TCP (High Efficiency)
  async function getElectrumBalancesBatch(host: string, port: number, addresses: string[]): Promise<number[]> {
    const scriptHashes = addresses.map(address => {
      try {
        let output: Buffer;
        if (address.startsWith('bc1') || address.startsWith('tb1')) {
           output = bitcoin.payments.p2wpkh({ address }).output!;
        } else if (address.startsWith('3') || address.startsWith('2')) {
           output = bitcoin.payments.p2sh({ address }).output!;
        } else {
           output = bitcoin.payments.p2pkh({ address }).output!;
        }
        const hash = bitcoin.crypto.sha256(output);
        return Buffer.from(hash).reverse().toString('hex');
      } catch (e) {
        return address; 
      }
    });

    return new Promise((resolve, reject) => {
      const client = new net.Socket();
      let response = '';

      client.connect(port, host, () => {
        const requests = scriptHashes.map((sh, idx) => ({
          id: idx,
          method: sh.length === 64 ? 'blockchain.scripthash.get_balance' : 'blockchain.address.get_balance',
          params: [sh]
        }));
        
        client.write(JSON.stringify(requests) + '\n');
      });

      client.on('data', (data) => {
        response += data.toString();
        try {
          if (response.trim().endsWith(']')) {
            const parsed = JSON.parse(response);
            if (Array.isArray(parsed)) {
              client.destroy();
              const results = parsed.sort((a,b) => a.id - b.id).map(r => 
                (r.result?.confirmed || 0) + (r.result?.unconfirmed || 0)
              );
              resolve(results);
            }
          }
        } catch (e) { /* partial data */ }
      });

      client.on('error', (err) => {
        client.destroy();
        reject(err);
      });

      setTimeout(() => {
        client.destroy();
        reject(new Error('Electrum Batch Timeout'));
      }, 15000);
    });
  }

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // In EXE, we just serve the static dist folder
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();
