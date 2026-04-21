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

  // --- Backend Settings ---
  const MAX_CONCURRENT_ELECTRUM = 25; // Balanced for Windows local dev
  const ELECTRUM_TIMEOUT = 7000;      // 7s - fast fail for local node
  const MAX_RETRIES = 3;               // Balanced retries

  // High-Performance Managed Pool for Electrum
  app.post('/api/check-balances', async (req, res) => {
    const { addresses, provider = 'electrum', phraseMap = {} } = req.body;
    
    if (!addresses || !Array.isArray(addresses)) {
      return res.status(400).json({ error: 'Addresses array required' });
    }

    if (provider === 'electrum') {
      const host = process.env.ELECTRUM_HOST || '127.0.0.1';
      const port = parseInt(process.env.ELECTRUM_PORT || '50001');

      try {
        const results: Record<string, number> = {};
        console.log(`[API] Checking ${addresses.length} addrs via Electrum...`);
        
        // Parallel map with p-limit style throttling
        const processAddress = async (addr: string) => {
          let attempt = 0;
          while (attempt < MAX_RETRIES) {
            try {
              const balance = await getElectrumBalance(host, port, addr);
              if (balance > 0) {
                const phrase = phraseMap[addr] || 'Found';
                saveFoundWallet(phrase, addr, balance, 'Electrum/Local');
              }
              return { addr, balance };
            } catch (e: any) {
              attempt++;
              if (attempt >= MAX_RETRIES) {
                console.error(`[Electrum] Offline/Timeout: ${addr} - ${e.message}`);
                return { addr, balance: 0 };
              }
              await new Promise(r => setTimeout(r, 100));
            }
          }
          return { addr, balance: 0 };
        };

        // Chunk into throttled parallel blocks
        for (let i = 0; i < addresses.length; i += MAX_CONCURRENT_ELECTRUM) {
           const chunk = addresses.slice(i, i + MAX_CONCURRENT_ELECTRUM);
           const chunkResults = await Promise.all(chunk.map(processAddress));
           chunkResults.forEach(r => results[r.addr] = r.balance);
        }
        
        console.log(`[Electrum] Verified ${addresses.length} addresses. Response OK.`);
        return res.json({ balances: results });
      } catch (e: any) {
        console.error(`[Electrum] Global Pool Error: ${e.message}`);
        return res.status(500).json({ error: 'Electrum Pool Error' });
      }
    } else {
      return res.status(501).json({ error: 'Provider not implemented' });
    }
  });

  // Balanced Socket Helper with aggressive cleanup and improved JSON parsing
  async function getElectrumBalance(host: string, port: number, address: string): Promise<number> {
    let scriptHash = '';
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
      scriptHash = Buffer.from(hash).reverse().toString('hex');
    } catch (e) {
      scriptHash = address; 
    }

    return new Promise((resolve, reject) => {
      const client = new net.Socket();
      let response = '';
      let timer: NodeJS.Timeout;

      const cleanup = () => {
        clearTimeout(timer);
        if (!client.destroyed) {
          client.destroy();
          client.unref();
        }
      };

      timer = setTimeout(() => {
        cleanup();
        reject(new Error('Electrum Timeout'));
      }, ELECTRUM_TIMEOUT);

      client.connect(port, host, () => {
        const method = scriptHash.length === 64 ? 'blockchain.scripthash.get_balance' : 'blockchain.address.get_balance';
        // Unique ID per request prevents collision on some nodes
        const requestId = Math.floor(Math.random() * 1000000);
        const query = JSON.stringify({
          id: requestId,
          method,
          params: [scriptHash]
        }) + '\n';
        client.write(query);
      });

      client.on('data', (data) => {
        response += data.toString();
        // Keep waiting until we get a newline or a closing brace that looks like valid JSON
        if (response.includes('\n')) {
          try {
            const lines = response.split('\n');
            for (const line of lines) {
              if (line.trim().length === 0) continue;
              const parsed = JSON.parse(line);
              if (parsed.error) {
                cleanup();
                return reject(new Error(parsed.error.message || 'Electrum RPC Error'));
              }
              cleanup();
              return resolve((parsed.result?.confirmed || 0) + (parsed.result?.unconfirmed || 0));
            }
          } catch (e) {
            // Partial JSON, wait for more chunks
          }
        }
      });

      client.on('error', (err) => {
        cleanup();
        reject(err);
      });
      
      client.on('close', () => cleanup());
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
