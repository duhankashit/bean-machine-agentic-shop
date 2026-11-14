import os
import unittest
from unittest.mock import patch

from backend.agent_graph import create_agent_graph


class ProviderConfigTests(unittest.TestCase):
    def test_creates_primary_and_fallback_groq_models(self):
        for configured_url in ("https://api.groq.com", "https://api.groq.com/openai/v1"):
            config = {
                "GROK_API_KEY": "test-key",
                "GROK_MODEL": "qwen/qwen3.8-27b",
                "GROK_FALLBACK_MODEL": "openai/gpt-oss-20b",
                "GROK_BASE_URL": configured_url,
            }
            with (
                self.subTest(base_url=configured_url),
                patch.dict(os.environ, config),
                patch("backend.agent_graph.ChatGroq") as chat_groq,
            ):
                create_agent_graph()

                self.assertEqual(chat_groq.call_count, 2)
                self.assertEqual(chat_groq.call_args_list[0].kwargs["model"], config["GROK_MODEL"])
                self.assertEqual(chat_groq.call_args_list[1].kwargs["model"], config["GROK_FALLBACK_MODEL"])
                for call in chat_groq.call_args_list:
                    self.assertEqual(call.kwargs["base_url"], "https://api.groq.com")
                    self.assertEqual(call.kwargs["api_key"], "test-key")


if __name__ == "__main__":
    unittest.main()
