import React from 'react';
import { createRoot } from 'react-dom/client';
import { Stage, Layer, Line } from 'react-konva';
createRoot(document.getElementById('root')!).render(<React.StrictMode><main><h1>船厂空间布局编辑器</h1><p>M0 数据契约工程；编辑界面将在 M1 接入。</p><Stage width={240} height={100}><Layer><Line points={[20, 60, 220, 60]} stroke="#156878" strokeWidth={3}/></Layer></Stage></main></React.StrictMode>);
