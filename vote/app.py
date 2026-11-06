from flask import Flask, render_template, request, make_response, g
from redis import Redis
import os
import socket
import random
import json
import logging

option_a = os.getenv('OPTION_A', "Cats")
option_b = os.getenv('OPTION_B', "Dogs")
hostname = socket.gethostname()

app = Flask(__name__)

gunicorn_error_logger = logging.getLogger('gunicorn.error')
app.logger.handlers.extend(gunicorn_error_logger.handlers)
app.logger.setLevel(logging.INFO)

# 在单次请求上下文中复用 Redis 客户端，避免同一请求重复创建连接对象
def get_redis():
    if not hasattr(g, 'redis'):
        g.redis = Redis(host="redis", db=0, socket_timeout=5)
    return g.redis

@app.route("/", methods=['POST','GET'])
def hello():
    # 浏览器没有身份 Cookie 时生成一个随机 ID，并在响应中写回
    voter_id = request.cookies.get('voter_id')
    if not voter_id:
        voter_id = hex(random.getrandbits(64))[2:-1]

    vote = None

    if request.method == 'POST':
        # 只允许页面定义的两个选项，并在访问 Redis 前拒绝非法输入
        vote = request.form.get('vote')
        if vote not in ('a', 'b'):
            return make_response('invalid vote', 400)

        redis = get_redis()
        app.logger.info('Received vote for %s', vote)
        data = json.dumps({'voter_id': voter_id, 'vote': vote})
        redis.rpush('votes', data)

    resp = make_response(render_template(
        'index.html',
        option_a=option_a,
        option_b=option_b,
        hostname=hostname,
        vote=vote,
    ))
    resp.set_cookie('voter_id', voter_id)
    return resp


@app.route('/healthz')
def healthz():
    # 存活检查不访问外部依赖，Redis 故障不应触发 vote 进程重启
    return {'status': 'ok'}


@app.route('/readyz')
def readyz():
    # 就绪检查验证 Redis，因为接收投票必须能够把消息写入队列
    try:
        get_redis().ping()
        return {'status': 'ready'}
    except Exception as exc:
        # 依赖不可用时返回 503，由编排或负载均衡停止转发业务流量
        app.logger.warning('Redis readiness check failed: %s', exc)
        return {'status': 'not-ready'}, 503


if __name__ == "__main__":
    # 该入口仅用于本地开发；生产镜像后续使用 Gunicorn 启动
    app.run(host='0.0.0.0', port=80, debug=True, threaded=True)
