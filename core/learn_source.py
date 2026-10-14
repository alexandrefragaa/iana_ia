"""Learn a public source or a bounded batch from the existing source files."""
import argparse
import json
import sys
from pathlib import Path

from dotenv import load_dotenv

if str(Path(__file__).resolve().parents[1]) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main():
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    from core.knowledge_jobs import DEFAULT_YOUTUBE_SEARCH, get_jobs
    parser = argparse.ArgumentParser(description="Extrai e salva fontes na base de conhecimento da Iana.")
    parser.add_argument("url", nargs="?", default=DEFAULT_YOUTUBE_SEARCH)
    parser.add_argument("--max-videos", type=int, default=5)
    parser.add_argument("--recent-days", type=int, default=7)
    parser.add_argument("--from-files", action="store_true", help="Aprende dos arquivos existentes em data/, incluindo textos fornecidos.")
    parser.add_argument("--max-sources", type=int, default=None, help="Limite de fontes por lote de arquivos (padrão 10, máximo 100).")
    parser.add_argument("--game", help="Jogo associado aos textos locais e tópicos no modo --from-files.")
    args = parser.parse_args()
    try:
        if args.from_files:
            from core.scrape_learning import learn_from_files
            result = learn_from_files(
                args.max_sources, {"max_videos": args.max_videos, "recent_days": args.recent_days, "jogo": args.game},
                progress=lambda item: print(f"[{item['index']}/{item['total']}] {item['source']}", file=sys.stderr),
            )
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 1 if result["status"] == "failed" else 0
        jobs = get_jobs()
        submitted = jobs.submit({"url": args.url, "max_videos": args.max_videos, "recent_days": args.recent_days})
        jobs.close()
        result = jobs.get(submitted["id"])
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 1 if result["status"] == "failed" else 0
    except (ValueError, RuntimeError) as problem:
        print(json.dumps({"status": "failed", "error": str(problem)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
