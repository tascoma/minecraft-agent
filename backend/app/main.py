import uvicorn
from fastapi import FastAPI

from app.core.config import get_settings
from app.routes.chat import router as chat_router

app = FastAPI(title='minecraft-agent')
app.include_router(chat_router)


@app.get('/health')
async def health() -> dict[str, str]:
    return {'status': 'ok'}


if __name__ == '__main__':
    settings = get_settings()
    uvicorn.run('app.main:app', host=settings.host, port=settings.port, reload=settings.reload)
