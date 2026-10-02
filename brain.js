(function () {
  const API = 'https://lumi-brain.onrender.com/lumi/chat';

  const STORAGE_KEY = 'lumi_conversation_memory_v1';
  const MAX_HISTORY = 12;

  function loadHistory() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      return Array.isArray(saved) ? saved.slice(-MAX_HISTORY) : [];
    } catch (error) {
      return [];
    }
  }

  let history = loadHistory();

  function saveHistory() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(history.slice(-MAX_HISTORY))
      );
    } catch (error) {
      // Lumi can still chat if browser storage is unavailable.
    }
  }

  window.LumiBrain = {
    async reply(message) {
      const cleanMessage = String(message || '').trim();

      if (!cleanMessage) {
        throw new Error('Message is empty');
      }

      const response = await fetch(API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          message: cleanMessage,
          history: history
        })
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || 'Brain server error ' + response.status);
      }

      const validEmotions = [
        'happy',
        'shy',
        'surprised',
        'playful',
        'angry',
        'sad'
      ];

      if (
        !data.reply ||
        !validEmotions.includes(data.emotion)
      ) {
        throw new Error('Invalid brain response');
      }

      history.push(
        { role: 'user', content: cleanMessage },
        { role: 'assistant', content: data.reply }
      );

      history = history.slice(-MAX_HISTORY);
      saveHistory();

      return data;
    },

    reset() {
      history = [];
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch (error) {}
    }
  };
})();
