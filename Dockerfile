FROM python:3.12-slim

WORKDIR /workspace

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY train.py .
COPY router.py .
COPY v32_cascade_weights.json .
COPY llmfit/ ./llmfit/

CMD ["python", "-u", "router.py"]
