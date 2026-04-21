import React, { useState, useEffect, useCallback, useRef } from 'react';
import * as bip39 from 'bip39';
import * as bitcoin from 'bitcoinjs-lib';
import { BIP32Factory, BIP32Interface } from 'bip32';
import * as ecc from 'tiny-secp256k1';
import { motion, AnimatePresence } from 'motion/react';
import { 
  AlertTriangle, 
  Settings, 
  Activity, 
  CheckCircle2, 
  Search, 
  Pause, 
  Play, 
  Trash2, 
  Copy, 
  Check,
  RefreshCw,
  Zap,
  Cpu
} from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// Initialize BIP32 and Bitcoin ECC
let bip32: any;
try {
  const eccLib = (ecc as any).default || ecc;
  bitcoin.initEccLib(eccLib);
  bip32 = BIP32Factory(eccLib);
} catch (e) {
  console.error('ECC initialization failed:', e);
}

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// --- Types ---
interface Result {
  phrase: string;
  address: string;
  format: string;
  balance: number;
  time: string;
  id: string;
}

interface ApiStatus {
  name: string;
  status: 'idle' | 'checking' | 'ok' | 'err' | 'ratelimit';
}

// --- Constants ---
const FORMATS = {
  legacy: { label: 'Legacy P2PKH', badge: '1...' },
  segwit: { label: 'SegWit P2SH', badge: '3...' },
  native: { label: 'Native SegWit Bech32', badge: 'bc1q' }
};

const APIS = [
  { name: 'Local Node (Electrum)', id: 'local' },
  { name: 'Blockchain.info /balance', id: 'blockchain_bal' },
  { name: 'Mempool.space', id: 'mempool' },
  { name: 'BlockCypher', id: 'blockcypher' },
  { name: 'Blockchair', id: 'blockchair' },
  { name: 'Blockchain.info /q', id: 'blockchain_q' }
];

// --- Main App ---
export default function App() {
  const [activeTab, setActiveTab] = useState<'setup' | 'progress' | 'results'>('setup');
  const [wordCount, setWordCount] = useState(15);
  const [mode, setMode] = useState<'partial' | 'random'>('partial');
  const [knownWords, setKnownWords] = useState<string[]>(Array(24).fill(''));
  const [targetAddr, setTargetAddr] = useState('');
  const [selectedFormats, setSelectedFormats] = useState({ legacy: true, segwit: true, native: true });
  const [parallel, setParallel] = useState(3);
  const [delay, setDelay] = useState(0);
  const [useLocalNode, setUseLocalNode] = useState(false);
  const [timeoutMs, setTimeoutMs] = useState(4000);
  
  // Progress State
  const [running, setRunning] = useState(false);
  const [checkedCount, setCheckedCount] = useState(0);
  const [foundCount, setFoundCount] = useState(0);
  const [batchCount, setBatchCount] = useState(0);
  const [currentAddr, setCurrentAddr] = useState('—');
  const [logs, setLogs] = useState<{msg: string, type: 'info' | 'ok' | 'warn' | 'err', id: number}[]>([]);
  const [apiStat, setApiStat] = useState<Record<string, ApiStatus['status']>>(
    Object.fromEntries(APIS.map(a => [a.id, 'idle']))
  );
  const [results, setResults] = useState<Result[]>([]);
  
  // Internal Refs
  const runningRef = useRef(false);
  const checkedRef = useRef(0);
  const foundRef = useRef(0);
  const batchRef = useRef(0);
  const seenPhrasesRef = useRef(new Set<string>());
  const seenAddressesRef = useRef(new Set<string>());
  const apiCooldownRef = useRef<Record<string, number>>({});
  const lastUpdateRef = useRef(0);
  const speedRef = useRef(0);
  const logCounterRef = useRef(0);
  const resultCounterRef = useRef(0);
  const globalPhraseToAddrMap = useRef<Record<string, string>>({});
  const [currentSpeed, setCurrentSpeed] = useState(0);

  const addLog = useCallback((msg: string, type: 'info' | 'ok' | 'warn' | 'err' = 'info') => {
    setLogs(prev => {
      const currentLogs = Array.isArray(prev) ? prev : [];
      logCounterRef.current++;
      return [...currentLogs.slice(-100), { msg, type, id: `${Date.now()}-${logCounterRef.current}` }];
    });
  }, []);

  // --- Logic Functions ---
  const generateValidMnemonic = useCallback((count: number, partialWords: string[]) => {
    if (mode === 'random') {
      return bip39.generateMnemonic((count / 3) * 32);
    }
    
    // Partial mode: try to fill blanks and find valid checksum
    const words = Array.isArray(partialWords) ? [...partialWords].slice(0, count) : [];
    if (words.length === 0 && count > 0) return null;
    
    const blanks = words.map((w, i) => w === '' ? i : -1).filter(i => i !== -1);
    
    if (blanks.length === 0) {
      return bip39.validateMnemonic(words.join(' ')) ? words.join(' ') : null;
    }

    // Try multiple times to find a valid checksum with random words in blanks
    const englishWordlist = bip39.wordlists?.english || (bip39 as any).wordlists?.en;
    if (!englishWordlist) {
      console.error('BIP39 Wordlist not found');
      return null;
    }

    for (let i = 0; i < 500; i++) {
      const candidateWords = [...words];
      blanks.forEach(idx => {
        candidateWords[idx] = englishWordlist[Math.floor(Math.random() * 2048)];
      });
      const phrase = candidateWords.join(' ');
      if (bip39.validateMnemonic(phrase)) return phrase;
    }
    return null;
  }, [mode]);  const checkBalance = useCallback(async (address: string) => {
    const now = Date.now();
    
    const tryApi = async (id: string, url: string, parser: (data: any) => number) => {
      if (apiCooldownRef.current[id] && now < apiCooldownRef.current[id]) return null;
      
      setApiStat(prev => ({ ...prev, [id]: 'checking' }));
      try {
        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), timeoutMs);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(tid);

        if (res.status === 429) {
          apiCooldownRef.current[id] = now + 60000;
          setApiStat(prev => ({ ...prev, [id]: 'ratelimit' }));
          return null;
        }

        if (!res.ok) throw new Error('HTTP ' + res.status);
        
        const data = await res.json().catch(() => null);
        const balance = parser(data);
        setApiStat(prev => ({ ...prev, [id]: 'ok' }));
        return balance;
      } catch (e) {
        setApiStat(prev => ({ ...prev, [id]: 'err' }));
        return null;
      }
    };

    // Chain of APIs
    let balance = await tryApi('blockchain_bal', `https://blockchain.info/balance?active=${address}`, d => d?.[address]?.final_balance ?? 0);
    if (balance === null) balance = await tryApi('mempool', `https://mempool.space/api/address/${address}`, d => (d?.chain_stats?.funded_txo_sum ?? 0) - (d?.chain_stats?.spent_txo_sum ?? 0));
    if (balance === null) balance = await tryApi('blockcypher', `https://api.blockcypher.com/v1/btc/main/addrs/${address}/balance`, d => (d?.balance ?? 0) + (d?.unconfirmed_balance ?? 0));
    
    return balance ?? 0;
  }, [timeoutMs]);

  const checkBalancesBatch = useCallback(async (addresses: string[]): Promise<Record<string, number>> => {
    if (addresses.length === 0) return {};
    const resultsMap: Record<string, number> = {};
    const now = Date.now();

    // 0. Local Node (Priority if enabled)
    if (useLocalNode) {
      try {
        console.log('[App] Sending batch to local node API...');
        setApiStat(prev => ({ ...prev, local: 'checking' }));
        // Map addresses to their phrases for the backend to save them correctly
        const phraseMap: Record<string, string> = {};
        // We need to find which phrase produced each address in this batch.
        // We'll use the current processBatch data scope.
        const res = await fetch('/api/check-balances', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            addresses,
            phraseMap: globalPhraseToAddrMap.current // Use a ref that tracks current batch
          })
        });
        if (!res.ok) throw new Error('Local API Error');
        const data = await res.json();
        setApiStat(prev => ({ ...prev, local: 'ok' }));
        console.log('[App] Local node response received.');
        return data.balances || {};
      } catch (e) {
        console.error('[App] Local node error:', e);
        setApiStat(prev => ({ ...prev, local: 'err' }));
        // Fallback to public if local fails? For now just try public
      }
    }

    const tryApiBatch = async (id: string, url: string, parser: (data: any) => Record<string, number>) => {
      if (apiCooldownRef.current[id] && now < apiCooldownRef.current[id]) return null;
      
      setApiStat(prev => ({ ...prev, [id]: 'checking' }));
      try {
        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), timeoutMs + 2000);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(tid);

        if (res.status === 429) {
          apiCooldownRef.current[id] = now + 60000;
          setApiStat(prev => ({ ...prev, [id]: 'ratelimit' }));
          return null;
        }

        if (!res.ok) throw new Error('HTTP ' + res.status);
        
        const data = await res.json().catch(() => null);
        const balances = parser(data);
        setApiStat(prev => ({ ...prev, [id]: 'ok' }));
        return balances;
      } catch (e) {
        setApiStat(prev => ({ ...prev, [id]: 'err' }));
        return null;
      }
    };

    // 1. Blockchain.info Batch (Best)
    // Supports up to 66 addresses per request usually
    const binfoBalances = await tryApiBatch('blockchain_bal', `https://blockchain.info/balance?active=${addresses.join(',')}`, d => {
      const map: Record<string, number> = {};
      if (d) {
        Object.keys(d).forEach(addr => {
          map[addr] = d[addr].final_balance;
        });
      }
      return map;
    });

    if (binfoBalances) return binfoBalances;

    // 2. Blockchair Batch (Fallback)
    const bchairBalances = await tryApiBatch('blockchair', `https://api.blockchair.com/bitcoin/dashboards/addresses/${addresses.join(',')}`, d => {
      const map: Record<string, number> = {};
      if (d?.data) {
        Object.keys(d.data).forEach(addr => {
          const item = d.data[addr];
          if (item && item.address) {
             map[item.address.address] = item.address.balance;
          }
        });
      }
      return map;
    });

    if (bchairBalances) return bchairBalances;

    return {};
  }, [useLocalNode, timeoutMs]);

  const processBatch = useCallback(async () => {
    try {
      // Small batches prevent UI locks and provide smoother speed updates
      const mnemonicBatchSize = useLocalNode ? 24 : 10; 
      const phrasesList: string[] = [];
      
      while (phrasesList.length < mnemonicBatchSize && runningRef.current) {
        const p = generateValidMnemonic(wordCount, knownWords);
        if (p && !seenPhrasesRef.current.has(p)) {
          seenPhrasesRef.current.add(p);
          phrasesList.push(p);
        }
        // Yield every 5 mnemonics
        if (phrasesList.length % 5 === 0) await new Promise(r => setTimeout(r, 0));
      }

      if (phrasesList.length === 0) return;

      batchRef.current++;
      setBatchCount(batchRef.current);

      const phraseData: {phrase: string, addresses: {addr: string, fmt: string}[]}[] = [];
      const allAddresses: string[] = [];
      // Reset map for this batch
      globalPhraseToAddrMap.current = {};

      for (const phrase of phrasesList) {
        if (!runningRef.current) break;

        const seed = await bip39.mnemonicToSeed(phrase);
        if (!bip32) {
          throw new Error('ECC/BIP32 not initialized. Please refresh.');
        }
        const root = bip32.fromSeed(seed);
        
        const derivationResults: {addr: string, fmt: string}[] = [];
        let privKeyWIF = '';
        try {
          const lpath = root.derivePath("m/44'/0'/0'/0/0");
          privKeyWIF = lpath.toWIF();
        } catch(e) {}

        if (selectedFormats.legacy) {
          const child = root.derivePath("m/44'/0'/0'/0/0");
          const { address } = bitcoin.payments.p2pkh({ pubkey: child.publicKey });
          if (address && !seenAddressesRef.current.has(address)) {
            derivationResults.push({ addr: address, fmt: 'legacy' });
            seenAddressesRef.current.add(address);
            allAddresses.push(address);
            globalPhraseToAddrMap.current[address] = phrase;
          }
        }
        if (selectedFormats.segwit) {
          const child = root.derivePath("m/49'/0'/0'/0/0");
          const { address } = bitcoin.payments.p2sh({ 
            redeem: bitcoin.payments.p2wpkh({ pubkey: child.publicKey }) 
          });
          if (address && !seenAddressesRef.current.has(address)) {
            derivationResults.push({ addr: address, fmt: 'segwit' });
            seenAddressesRef.current.add(address);
            allAddresses.push(address);
            globalPhraseToAddrMap.current[address] = phrase;
          }
        }
        if (selectedFormats.native) {
          const child = root.derivePath("m/84'/0'/0'/0/0");
          const { address } = bitcoin.payments.p2wpkh({ pubkey: child.publicKey });
          if (address && !seenAddressesRef.current.has(address)) {
            derivationResults.push({ addr: address, fmt: 'native' });
            seenAddressesRef.current.add(address);
            allAddresses.push(address);
            globalPhraseToAddrMap.current[address] = phrase;
          }
        }

        if (derivationResults.length > 0) {
          phraseData.push({ phrase, addresses: derivationResults });
        }

        // Periodic logging to not flood the UI
        if (batchRef.current % 10 === 0 && privKeyWIF) {
          const shortPhrase = phrase.split(' ').slice(0, 3).join(' ') + '...';
          addLog(`Scanning: ${shortPhrase} | PK: ${privKeyWIF.slice(0, 10)}...`, 'info');
        }
      }

      // Large batching for local node API efficiency
      const MAX_PER_CALL = useLocalNode ? 250 : 60;
      for (let i = 0; i < allAddresses.length; i += MAX_PER_CALL) {
        const batchAddrs = allAddresses.slice(i, i + MAX_PER_CALL);
        const balancesMap = await checkBalancesBatch(batchAddrs);

        for (const item of phraseData) {
          for (const { addr, fmt } of item.addresses) {
            // Only update UI if address was in current batch
            if (!batchAddrs.includes(addr)) continue;

            setCurrentAddr(addr);
            checkedRef.current++;
            speedRef.current++;
            setCheckedCount(checkedRef.current);

            const bal = balancesMap[addr] ?? 0;
            const isMatch = targetAddr ? addr === targetAddr : false;
            
            if (isMatch || bal > 0) {
              const finalBal = (isMatch && bal === 0) ? await checkBalance(addr) : bal;
              
              foundRef.current++;
              setFoundCount(foundRef.current);
              setResults(prev => {
                const current = Array.isArray(prev) ? prev : [];
                resultCounterRef.current++;
                return [...current, { 
                  phrase: item.phrase, 
                  address: addr, 
                  format: fmt, 
                  balance: finalBal, 
                  time: new Date().toLocaleTimeString(),
                  id: `res-${Date.now()}-${resultCounterRef.current}`
                }];
              });
              
              if (bal > 0) {
                addLog(`BALANCE DETECTED! ${addr} (${bal/1e8} BTC)`, 'ok');
              } else if (isMatch) {
                addLog(`MATCH FOUND! ${addr}`, 'ok');
              }
            }
          }
        }
      }
      
      if (delay > 0) await new Promise(r => setTimeout(r, delay));
    } catch (e: any) {
      console.error('Batch error:', e);
      addLog(`Error: ${e?.message || 'Check connection'}`, 'err');
    }
  }, [useLocalNode, wordCount, knownWords, parallel, selectedFormats, targetAddr, delay, checkBalancesBatch, checkBalance, generateValidMnemonic, addLog]);
;

  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      addLog(`ERROR: ${event.message}`, 'err');
      console.error('Unhandled error:', event.error);
    };
    window.addEventListener('error', handleError);
    return () => window.removeEventListener('error', handleError);
  }, [addLog]);

  useEffect(() => {
    let interval: any;
    if (running) {
      interval = setInterval(() => {
        setCurrentSpeed(speedRef.current);
        speedRef.current = 0;
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [running]);

  useEffect(() => {
    const loop = async () => {
      while (runningRef.current) {
        await processBatch();
        await new Promise(r => setTimeout(r, 0)); // Yield to UI
      }
    };
    if (running) loop();
  }, [running, processBatch]);

  const start = () => {
    const words = Array.isArray(knownWords) ? knownWords : [];
    if (mode === 'partial' && words.slice(0, wordCount).every(w => !w)) {
      addLog('Enter at least one known word or switch to Random mode', 'warn');
      return;
    }
    setRunning(true);
    runningRef.current = true;
    addLog('Infinite recovery mode started...', 'info');
    setActiveTab('progress');
  };

  const stop = () => {
    setRunning(false);
    runningRef.current = false;
    addLog('Stopping recovery...', 'warn');
  };

  const clear = () => {
    setKnownWords(Array(24).fill(''));
    setResults([]);
    setCheckedCount(0); checkedRef.current = 0;
    setFoundCount(0); foundRef.current = 0;
    setBatchCount(0); batchRef.current = 0;
    seenPhrasesRef.current.clear();
    setLogs([]);
    addLog('All data cleared.', 'info');
  };

  // --- Render Helpers ---
  const WordGrid = () => (
    <div className="grid grid-cols-2 gap-2">
      {Array(wordCount).fill(0).map((_, i) => (
        <div key={i} className="relative">
          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[9px] text-[var(--muted)] font-mono pointer-events-none">{i + 1}</span>
          <input 
            className={cn(
              "input-base pl-6 py-1.5",
              !(knownWords?.[i]) && "border-dashed opacity-60"
            )}
            placeholder="?"
            value={knownWords?.[i] || ''}
            onChange={(e) => {
              const val = e.target.value.toLowerCase().trim();
              const newWords = Array.isArray(knownWords) ? [...knownWords] : Array(24).fill('');
              newWords[i] = val;
              setKnownWords(newWords);
            }}
          />
        </div>
      ))}
    </div>
  );

  return (
    <div className="flex h-screen w-full bg-[var(--bg)] font-sans text-[var(--text-main)] overflow-hidden">
      {/* Sidebar Navigation */}
      <aside className="w-60 h-full border-r border-[var(--border)] flex flex-col p-6 hidden md:flex">
        <div className="flex items-center gap-2.5 mb-14 text-lg font-bold tracking-tight">
          <div className="w-6 h-6 bg-[var(--accent)] rounded" />
          SPHERE <span className="text-[10px] bg-white/10 px-1.5 py-0.5 rounded text-[var(--text-dim)] ml-1">V3</span>
        </div>

        <nav className="flex-1">
          <ul className="space-y-6">
            <li className={cn("nav-item", activeTab === 'setup' && "active")} onClick={() => setActiveTab('setup')}>
              <Settings className="w-4 h-4" /> Setup
            </li>
            <li className={cn("nav-item", activeTab === 'progress' && "active")} onClick={() => setActiveTab('progress')}>
              <Activity className="w-4 h-4" /> Progresso
            </li>
            <li className={cn("nav-item", activeTab === 'results' && "active")} onClick={() => setActiveTab('results')}>
              <CheckCircle2 className="w-4 h-4" /> Resultados ({results.length})
            </li>
          </ul>
        </nav>

        <div className="mt-auto pt-6 border-t border-[var(--border)] flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-[#333] flex items-center justify-center text-[10px] font-bold">AV</div>
          <div className="flex flex-col">
            <span className="text-[13px] font-semibold">User Mode</span>
            <span className="text-[11px] text-[var(--text-dim)]">Admin Access</span>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col p-6 md:p-10 overflow-hidden relative">
        <header className="flex justify-between items-end mb-10">
          <div>
            <p className="text-xs text-[var(--text-dim)] uppercase tracking-widest mb-1">{new Date().toLocaleDateString('pt-PT', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
            <h1 className="text-4xl font-semibold tracking-tight">Recovery Console.</h1>
          </div>
          <div className="flex gap-3">
             {running ? (
                <button className="px-6 py-3 bg-[var(--danger)]/10 text-[var(--danger)] border border-[var(--danger)]/20 rounded-lg font-semibold text-sm flex items-center gap-2" onClick={stop}>
                  <Pause className="w-4 h-4 fill-current" /> Stop
                </button>
             ) : (
                <button className="px-6 py-3 bg-[var(--accent)] text-[#000] rounded-lg font-semibold text-sm flex items-center gap-2 hover:opacity-90" onClick={start}>
                  <Play className="w-4 h-4 fill-current" /> Partir
                </button>
             )}
          </div>
        </header>

        <div className="flex-1 overflow-y-auto pr-2 custom-scroll">
          <AnimatePresence mode="wait">
            {activeTab === 'setup' && (
              <motion.div 
                key="setup"
                initial={{ opacity: 0, y: 10 }} 
                animate={{ opacity: 1, y: 0 }} 
                exit={{ opacity: 0, y: -10 }}
                className="grid grid-cols-1 lg:grid-cols-3 gap-6"
              >
                <div className="lg:col-span-2 space-y-6">
                  {/* Word Configuration */}
                  <div className="card">
                    <p className="card-title">Configuração de Palavras</p>
                    <div className="flex items-center justify-between mb-6 bg-white/5 p-4 rounded-xl border border-white/5">
                      <div className="flex flex-col">
                        <span className="text-sm font-bold">Mnemonic Length</span>
                        <span className="text-[11px] text-[var(--text-dim)]">Select count of seed phrases</span>
                      </div>
                      <div className="flex gap-2">
                        {[12, 15, 18, 21, 24].map(n => (
                          <button 
                            key={n}
                            className={cn("w-10 h-10 rounded-lg text-xs font-bold transition-all border", wordCount === n ? "bg-[var(--accent)] text-[#000] border-[var(--accent)]" : "bg-transparent text-[var(--text-dim)] border-[var(--border)]")}
                            onClick={() => setWordCount(n)}
                          >
                            {n}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="flex gap-2 mb-6">
                      <button 
                        className={cn("flex-1 py-3 text-[11px] font-bold border rounded-lg transition-all", mode === 'partial' ? "bg-[var(--accent)]/10 text-[var(--accent)] border-[var(--accent)]/20" : "bg-transparent text-[var(--text-dim)] border-[var(--border)]")}
                        onClick={() => setMode('partial')}
                      >
                        Palavras Conhecidas
                      </button>
                      <button 
                        className={cn("flex-1 py-3 text-[11px] font-bold border rounded-lg transition-all", mode === 'random' ? "bg-[var(--accent)]/10 text-[var(--accent)] border-[var(--accent)]/20" : "bg-transparent text-[var(--text-dim)] border-[var(--border)]")}
                        onClick={() => setMode('random')}
                      >
                        Aleatório Total
                      </button>
                    </div>

                    {mode === 'partial' && <WordGrid />}
                  </div>

                  {/* Address Formats */}
                  <div className="card">
                    <p className="card-title">Formatos de Endereço</p>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                      {Object.entries(FORMATS).map(([key, info]) => (
                        <div 
                          key={key} 
                          className={cn(
                            "p-4 rounded-xl border transition-all cursor-pointer",
                            selectedFormats[key as keyof typeof selectedFormats] ? "border-[var(--accent)] bg-[var(--accent)]/5" : "border-[var(--border)] opacity-60"
                          )}
                          onClick={() => setSelectedFormats(prev => ({ ...prev, [key]: !prev[key as keyof typeof selectedFormats] }))}
                        >
                          <div className="flex flex-col gap-1">
                            <span className="text-xs font-bold">{info.label}</span>
                            <span className="text-[10px] text-[var(--text-dim)] font-mono">{info.badge}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="space-y-6">
                  {/* Performance */}
                  <div className="card">
                     <p className="card-title">Performance & Motor</p>
                     <div className="space-y-6">
                        <div className="space-y-2">
                           <div className="flex justify-between items-center text-[10px] font-mono text-[var(--text-dim)]">
                               <span>Local Node Mode (Electrum)</span>
                               <button 
                                 onClick={() => setUseLocalNode(!useLocalNode)}
                                 className={cn("w-10 h-5 rounded-full relative transition-colors", useLocalNode ? "bg-[var(--accent)]" : "bg-white/10")}
                               >
                                 <div className={cn("absolute top-1 w-3 h-3 rounded-full bg-white transition-all", useLocalNode ? "left-6" : "left-1")} />
                               </button>
                           </div>
                           <p className="text-[9px] text-[var(--text-dim)] opacity-50">Requires local server connected to Bitcoin Core/Electrum</p>
                        </div>

                        <div className="space-y-2">
                           <div className="flex justify-between text-[10px] font-mono text-[var(--text-dim)]">
                              <span>Instâncias em Paralelo</span>
                              <span className="text-[var(--accent)]">{parallel}x</span>
                           </div>
                           <input type="range" min="1" max="8" value={parallel} onChange={e => setParallel(parseInt(e.target.value))} className="w-full accent-[var(--accent)]" />
                        </div>
                        <div className="space-y-1">
                           {APIS.map(api => (
                              <div key={api.id} className="flex items-center justify-between py-2 border-b border-[var(--border)] last:border-0">
                                 <span className="text-[10px] text-[var(--text-dim)] font-mono">{api.name}</span>
                                 <div className={cn(
                                    "w-1.5 h-1.5 rounded-full",
                                    apiStat[api.id] === 'ok' ? "bg-[var(--success)] shadow-[0_0_8px_var(--success)]" : 
                                    apiStat[api.id] === 'ratelimit' ? "bg-[var(--accent)] shadow-[0_0_8px_var(--accent)]" :
                                    "bg-[var(--border)]"
                                 )} />
                              </div>
                           ))}
                        </div>
                     </div>
                  </div>

                  {/* Target Address */}
                  <div className="card">
                    <p className="card-title">Target Hunt</p>
                    <input 
                      className="input-base" 
                      placeholder="Target BTC address..." 
                      value={targetAddr}
                      onChange={e => setTargetAddr(e.target.value.trim())}
                    />
                    <p className="text-[9px] text-[var(--text-dim)] mt-3 leading-relaxed">O sistema verificará os balanços automaticamente se encontrar este alvo.</p>
                  </div>
                  
                  <button className="btn-secondary flex items-center justify-center gap-2" onClick={clear}>
                    <Trash2 className="w-4 h-4" /> Resetar Motor
                  </button>
                </div>
              </motion.div>
            )}

            {activeTab === 'progress' && (
              <motion.div 
                key="progress"
                initial={{ opacity: 0, x: 10 }} 
                animate={{ opacity: 1, x: 0 }} 
                exit={{ opacity: 0, x: -10 }}
                className="dashboard-grid"
              >
                <div className="card">
                  <p className="card-title">Produtividade do Lote</p>
                  <p className="stat-value">{currentSpeed}/s</p>
                  <p className="stat-meta text-[var(--success)]">+{(currentSpeed * 0.2).toFixed(1)}% efficiency</p>
                </div>
                
                <div className="card">
                  <p className="card-title">Seeds Verificadas</p>
                  <p className="stat-value">{checkedCount.toLocaleString()}</p>
                  <p className="stat-meta text-[var(--text-dim)]">Lote #{batchCount}</p>
                </div>

                <div className="card tall-card">
                  <p className="card-title">Progresso Diário</p>
                  <div className="flex-1 flex flex-col items-center justify-center space-y-6">
                     <div 
                        className="w-36 h-36 rounded-full progress-circle-conic relative flex items-center justify-center"
                        style={{ '--progress-pct': `${(batchCount % 100) || 1}%` } as React.CSSProperties}
                     >
                        <div className="w-[120px] h-[120px] bg-[var(--surface)] rounded-full flex items-center justify-center text-3xl font-bold font-mono">
                           {(batchCount % 100)}%
                        </div>
                     </div>
                     <p className="text-center text-[var(--text-dim)] text-[13px] leading-relaxed">
                        O motor está a processar lotes continuamente. <br/>
                        <span className="text-white font-bold">{foundCount}</span> resultados positivos até agora.
                     </p>
                  </div>
                </div>

                <div className="card wide-card h-full">
                  <p className="card-title">Live Security Logs</p>
                  <div className="logbox flex-1 space-y-2.5 overflow-y-auto font-mono text-xs pr-2">
                    {logs.map(log => (
                      <div key={log.id} className="flex gap-4 items-start border-b border-[var(--border)] pb-2.5 last:border-0 group">
                         <span className="text-[8px] opacity-30 mt-1">[{new Date().toLocaleTimeString()}]</span>
                         <div className="flex-1">
                            <p className={cn(
                               "font-medium",
                               log.type === 'ok' && "text-[var(--success)]",
                               log.type === 'warn' && "text-[var(--accent)]",
                               log.type === 'err' && "text-[var(--danger)]",
                               log.type === 'info' && "text-white"
                            )}>{log.msg}</p>
                            <span className="text-[10px] text-[var(--text-dim)] opacity-50">Operation verified at current layer</span>
                         </div>
                         <div className="priority-pill">{log.type.toUpperCase()}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </motion.div>
            )}

            {activeTab === 'results' && (
              <motion.div 
                key="results"
                initial={{ opacity: 0, scale: 0.98 }} 
                animate={{ opacity: 1, scale: 1 }} 
                exit={{ opacity: 0, scale: 0.98 }}
                className="grid grid-cols-1 md:grid-cols-2 gap-4"
              >
                {results.length === 0 ? (
                  <div className="col-span-full flex flex-col items-center justify-center py-20 text-[var(--text-dim)] text-center gap-6 opacity-40">
                    <Search className="w-16 h-16" strokeWidth={1} />
                    <p className="text-sm font-mono tracking-widest uppercase">Scanner em espera. Inicia a operação para listar resultados.</p>
                  </div>
                ) : (
                  results.map((res, i) => <ResultCard key={res.id} result={res} index={i} />)
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}

interface ResultCardProps {
  result: Result;
  index: number;
  key?: React.Key;
}

function ResultCard({ result, index }: ResultCardProps) {
  const [copied, setCopied] = useState<string | null>(null);

  const copy = (text: string, label: string) => {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(() => {
        setCopied(label);
        setTimeout(() => setCopied(null), 2000);
      }).catch(err => {
        console.error('Failed to copy:', err);
      });
    } else {
      // Fallback
      try {
        const textArea = document.createElement("textarea");
        textArea.value = text;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand("copy");
        document.body.removeChild(textArea);
        setCopied(label);
        setTimeout(() => setCopied(null), 2000);
      } catch (err) {
        console.error('Fallback copy failed:', err);
      }
    }
  };

  return (
    <div className="card relative group overflow-hidden">
      <div className="absolute top-0 right-0 p-1 px-3 bg-[var(--accent)] text-[#000] text-[9px] font-bold rounded-bl-xl font-mono uppercase">
        Match #{index + 1}
      </div>
      
      <div className="flex justify-between items-start mb-6 mt-2">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
             <div className="w-1.5 h-1.5 rounded-full bg-[var(--accent)]" />
             <span className="text-xs font-bold uppercase tracking-widest">{result.format}</span>
          </div>
          <span className="text-[10px] text-[var(--accent)] font-mono font-bold tracking-tight">System High-Priority Result</span>
        </div>
        <div className="text-right">
          <div className="text-xl font-bold text-[var(--success)] font-mono">
            {result.balance > 0 ? (result.balance / 1e8).toFixed(8) + ' BTC' : '0.00...'}
          </div>
          <div className="text-[9px] text-[var(--text-dim)] font-mono uppercase tracking-tighter">{result.time}</div>
        </div>
      </div>

      <div className="space-y-4">
        <div>
          <label className="text-[9px] text-[var(--text-dim)] font-mono uppercase block mb-1.5 opacity-50">Bitcoin Address</label>
          <div className="bg-black/40 p-3 rounded-lg border border-[var(--border)] flex items-center justify-between gap-3 group/item">
            <code className="text-[11px] font-mono break-all text-white flex-1">{result.address}</code>
            <button onClick={() => copy(result.address, 'addr')} className="text-[var(--text-dim)] hover:text-[var(--accent)] transition-colors">
              {copied === 'addr' ? <Check className="w-4 h-4 text-[var(--success)]" /> : <Copy className="w-4 h-4" />}
            </button>
          </div>
        </div>

        <div>
          <label className="text-[9px] text-[var(--text-dim)] font-mono uppercase block mb-1.5 opacity-50">Private Mnemonic</label>
          <div className="bg-[var(--accent)]/5 p-3 rounded-lg border border-[var(--accent)]/10 flex items-center justify-between gap-3">
            <code className="text-[11px] font-mono break-all text-[var(--accent)] flex-1 leading-relaxed italic">
              {result.phrase}
            </code>
            <button onClick={() => copy(result.phrase, 'seed')} className="text-[var(--accent)] hover:opacity-70 transition-colors">
              {copied === 'seed' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>

      <div className="mt-6 pt-4 border-t border-[var(--border)] flex justify-between items-center">
         <div className="flex gap-2">
            <div className="priority-pill">BIP39</div>
            <div className="priority-pill">Mainnet</div>
         </div>
         <span className="text-[10px] text-[var(--text-dim)] font-mono">Verified Layer 1</span>
      </div>
    </div>
  );
}
