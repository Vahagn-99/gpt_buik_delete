export const storage = {
  async get<T = any>(key: string): Promise<T | undefined> {
    return new Promise((resolve) => {
      chrome.storage.local.get([key], (res) => resolve(res[key]));
    });
  },
  async set<T = any>(key: string, val: T): Promise<void> {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [key]: val }, () => resolve());
    });
  },
  async remove(key: string): Promise<void> {
    return new Promise((resolve) => {
      chrome.storage.local.remove([key], () => resolve());
    });
  }
};
