Fix bug in matterbridge-ai-factory-reolink-cam-ras-ip-doorbells-nvr. Be concise, write code not explanations.

Bug report:
I configured the plugin with a single camera address. However, I see multiple motion detection features and multiple switch features, but I have no idea what action each one performs. The actions for each feature need to be clearly specified.
Similarly, labels like 'Reolink (Channel 0) 3' or 'Reolink (Channel 0) 4' are not very descriptive. These should be clarified based on the table added to the README file in the last commit (4aaee36c0573f18d2fe1f8323ddcd3b0cdd77fdd), which maps each feature to its specific function.

<img width="1547" height="928" alt="Image" src="https://github.com/user-attachments/assets/ff590f94-97ad-4415-bb59-7f48fec548c4" />

<img width="1254" height="1143" alt="Image" src="https://github.com/user-attachments/assets/77feb17d-f9dc-4bae-bda9-3b23da1fa3e9" />

<img width="2484" height="133" alt="Image" src="https://github.com/user-attachments/assets/3b93cc54-e0e0-410e-b01b-f3f6cc2ede6f" />

Fix the code, then test:
```bash
npm run build && npm install -g . && timeout 30 matterbridge -add matterbridge-ai-factory-reolink-cam-ras-ip-doorbells-nvr 2>&1 || true && timeout 30 matterbridge -bridge 2>&1 || true
```

Not done until matterbridge starts without errors.