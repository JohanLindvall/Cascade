/**
 * The live demo's entry, which vite.config.ts puts in place of main.tsx in
 * demo mode. ES modules run in import order, so the simulated server is
 * installed before any module of the app has run.
 */
import './install.ts';
import '../main.tsx';
import './notice.ts';
import './demo.css';
