from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI

from app.core.config import get_settings
from app.core.logging import setup_logging
from app.routes.chat import router as chat_router


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncGenerator[None]:
    # Runs in the server worker only, so the reloader process doesn't also open the log file.
    setup_logging()
    yield


app = FastAPI(title='minecraft-agent', lifespan=lifespan)
app.include_router(chat_router)


@app.get('/health')
async def health() -> dict[str, str]:
    return {'status': 'ok'}


if __name__ == '__main__':
    settings = get_settings()
    uvicorn.run('app.main:app', host=settings.host, port=settings.port, reload=settings.reload)
