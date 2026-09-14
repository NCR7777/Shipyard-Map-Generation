import { defineConfig } from '@playwright/test';
import base from './playwright.config';
export default defineConfig({...base,testDir:'./tests/e2e',testMatch:['FAST01_tracing.spec.ts','RF01_workbench.spec.ts','SV01_save.spec.ts','M11_localFileFlow.spec.ts','BG01_editor.spec.ts'],workers:1,
 outputDir:'.cache/FAST01/production/browser',reporter:[['list'],['json',{outputFile:'.cache/FAST01/production/report.json'}]],
 use:{...base.use,baseURL:'http://127.0.0.1:48155',video:'on',trace:'retain-on-failure'},
 webServer:{command:'npm run preview -- --port 48155 --strictPort',url:'http://127.0.0.1:48155',reuseExistingServer:false,timeout:30000}
});
