import './utils/bridge';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { IS_ANDROID, IS_TV } from './utils/platform';
import { initRemoteText } from './utils/remoteText';
import { initTvNav } from './utils/tvNav';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

if (IS_TV) initTvNav();
if (IS_ANDROID) initRemoteText();
