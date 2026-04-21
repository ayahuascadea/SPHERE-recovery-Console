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
    const { addresses, provider = 'electrum' } = req.body;
    
    if (!addresses || !Array.isArray(addresses)) {
      return res.status(400).json({ error: 'Addresses array required' });
    }

    console.log(`[API] Checking balance for ${addresses.length} addresses via ${provider}`);

    if (provider === 'electrum') {
      const host = process.env.ELECTRUM_HOST || '127.0.0.1';
      const port = parseInt(process.env.ELECTRUM_PORT || '50001');

      console.log(`[Electrum] Connecting to ${host}:${port}...`);

      try {
        const results: Record<string, number> = {};
        
        // Use Promise.all for truly parallel local scanning
        const balancePromises = addresses.map(async (addr) => {
          try {
            const balance = await getElectrumBalance(host, port, addr);
            return { addr, balance };
          } catch (e: any) {
            console.error(`[Electrum] Error checking ${addr}: ${e.message}`);
            return { addr, balance: 0 };
          }
        });

        const balances = await Promise.all(balancePromises);
        balances.forEach(item => {
          results[item.addr] = item.balance;
        });
        
        console.log(`[Electrum] Batch completed successfully.`);
        return res.json({ balances: results });
      } catch (e: any) {
        console.error(`[Electrum] Critical Error: ${e.message}`);
        return res.status(500).json({ error: 'Electrum Error: ' + e.message });
      }
    } else {
      // Bitcoin Core scan (Fallback)
      try {
        // scantxoutset is best for unspent outputs but slow
        // Alternatively, if they have an address index or descriptor wallet
        // For local speed, Electrum is highly recommended for scanning
        return res.status(501).json({ error: 'Bitcoin Core batch scan requires descriptor wallet or address indexing.' });
      } catch (e: any) {
        return res.status(500).json({ error: 'BTC Core Error: ' + e.message });
      }
    }
  });

  // Helper for Electrum TCP
  async function getElectrumBalance(host: string, port: number, address: string): Promise<number> {
    let scriptHash = '';
    try {
      // Convert address to Electrum script hash
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
      // Fallback to address if conversion fails (older Electrum servers)
      scriptHash = address; 
    }

    return new Promise((resolve, reject) => {
      const client = new net.Socket();
      let response = '';

      client.connect(port, host, () => {
        // Electrum 1.4+ uses scripthash. older uses address.
        const method = scriptHash.length === 64 ? 'blockchain.scripthash.get_balance' : 'blockchain.address.get_balance';
        const query = JSON.stringify({
          id: Date.now(),
          method,
          params: [scriptHash]
        }) + '\n';
        client.write(query);
      });

      client.on('data', (data) => {
        response += data.toString();
        try {
          const parsed = JSON.parse(response);
          client.destroy();
          // Electrum returns { confirmed: X, unconfirmed: Y } in satoshis
          resolve((parsed.result?.confirmed || 0) + (parsed.result?.unconfirmed || 0));
        } catch (e) {
          // Wait for more data
        }
      });

      client.on('error', (err) => {
        client.destroy();
        reject(err);
      });

      setTimeout(() => {
        client.destroy();
        reject(new Error('Electrum Timeout'));
      }, 5000);
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
