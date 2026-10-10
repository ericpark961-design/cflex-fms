// Standalone KMX CCR demo entry: no auth, no API, ledger JSON embedded. Built to a single HTML file (vite.demo.config.js).
import React from 'react';
import { createRoot } from 'react-dom/client';
import TwinScreen from './TwinScreen';
createRoot(document.getElementById('root')).render(<TwinScreen q={{ scene: 'kmx' }} standalone />);
