import React from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './style.css';
import App from './App';
import { installNoSwipeNav } from './noSwipeNav';

/* 0910：Mac 触控板双指左右滑会触发浏览器「滑动翻页」，把整页带走。
   在 React 挂载前就装上——capture 阶段比任何组件监听器都早。 */
installNoSwipeNav();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
