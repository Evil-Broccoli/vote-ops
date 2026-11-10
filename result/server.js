var express = require('express'),
    async = require('async'),
    { Pool } = require('pg'),
    cookieParser = require('cookie-parser');

// 使用 Node 内置路径模块生成首页文件路径。
var path = require('path');

function collectVotesFromResult(result) {
  // 数据库可能没有某个选项的记录，先补零再填入实际票数。
  var votes = {a: 0, b: 0};

  result.rows.forEach(function (row) {
    // PostgreSQL 的 COUNT 通常以字符串返回，页面计算前要转为数字。
    votes[row.vote] = parseInt(row.count);
  });

  return votes;
}

// 每次调用创建独立应用；测试可以传入假的 Pool，生产启动默认创建真实 Pool。
function createApplication(options = {}) {
  var app = express();
  var server = require('http').Server(app);
  var io = require('socket.io')(server);
  var port = process.env.PORT || 4000;
  var pool = options.pool || new Pool({
    connectionString: 'postgres://postgres:postgres@db/postgres'
  });

  // 保留原有 Socket.IO 协议，使浏览器仍能接收欢迎消息和统计广播。
  io.on('connection', function (socket) {
    socket.emit('message', { text : 'Welcome!' });
    socket.on('subscribe', function (data) {
      socket.join(data.channel);
    });
  });

  function start() {
    // 显式启动时才连接数据库；仅创建应用不会启动重试和轮询。
    async.retry(
      {times: 1000, interval: 1000},
      function(callback) {
        pool.connect(function(err, client, done) {
          if (err) {
            console.error("Waiting for db");
          }
          callback(err, client);
        });
      },
      function(err, client) {
        if (err) {
          return console.error("Giving up");
        }
        console.log("Connected to db");
        getVotes(client);
      }
    );

    // 保持原有启动行为：调用 start 后才监听 HTTP 端口。
    server.listen(port, function () {
      var port = server.address().port;
      console.log('App running on port ' + port);
    });
  }

  function getVotes(client) {
    // 保留每秒统计并广播的业务链路，接口测试无需启动该循环。
    client.query('SELECT vote, COUNT(id) AS count FROM votes GROUP BY vote', [], function(err, result) {
      if (err) {
        console.error("Error performing query: " + err);
      } else {
        var votes = collectVotesFromResult(result);
        io.sockets.emit("scores", JSON.stringify(votes));
      }

      setTimeout(function() {getVotes(client) }, 1000);
    });
  }

  app.use(cookieParser());
  // 投票表单使用简单键值对，明确解析模式并消除原来的弃用提示。
  app.use(express.urlencoded({ extended: false }));
  app.use(express.static(__dirname + '/views'));

  app.get('/', function (req, res) {
    res.sendFile(path.resolve(__dirname + '/views/index.html'));
  });

  // 存活只确认应用能处理 HTTP，请求路径不依赖数据库。
  app.get('/healthz', function (req, res) {
    res.json({ status: 'ok' });
  });

  app.get('/readyz', async function (req, res) {
    try {
      // 简单 SQL 验证连接和查询能力，不依赖 votes 表是否已经创建。
      await pool.query('SELECT 1');
      res.json({ status: 'ready' });
    } catch (error) {
      // 将依赖故障转换成明确的 503，并保留日志供排查。
      console.warn('Database readiness check failed: ' + error.message);
      res.status(503).json({ status: 'not-ready' });
    }
  });

  // 暴露服务器对象供接口测试使用临时端口，同时保留生产启动入口。
  return { app, server, io, pool, start };
}

// 直接执行才创建并启动应用，测试导入只取得函数定义。
if (require.main === module) {
  createApplication().start();
}

module.exports = { collectVotesFromResult, createApplication };
