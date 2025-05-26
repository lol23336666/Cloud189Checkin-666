require("dotenv").config();
const fs = require('fs')
const { CloudClient,FileTokenStore } = require("cloud189-sdk");
const recording = require("log4js/lib/appenders/recording");
const accounts = require("../accounts");
const families = require("../families");

const {
  mask,
  delay,
} = require("./utils");
const { log4js, cleanLogs, catLogs } = require("./logger");
const execThreshold = process.env.EXEC_THRESHOLD || 1;
const tokenDir = ".token"

// 个人任务签到
const doUserTask = async (cloudClient, logger) => {
  const tasks = Array.from({ length: execThreshold }, () =>
    cloudClient.userSign()
  );
  const result = (await Promise.allSettled(tasks)).filter(({ status, value }) => status === "fulfilled" && !value.isSign && value.netdiskBonus);
  //const result = (await Promise.allSettled(tasks)).filter(({status,value })=> status ==='fulfilled' && !value.isSign);
  console.log(
    `个人签到任务: 成功数 ${result.length} 获得 ${
      result.map(({ value }) => value.netdiskBonus)?.join(",") || "0"
    }M 空间`
  );
};

// 家庭任务签到
const doFamilyTask = async (cloudClient, logger) => {
  const { familyInfoResp } = await cloudClient.getFamilyList();
  if (familyInfoResp) {
    let familyId = null;
    //指定家庭签到
    if (families.length > 0) {
      const tagetFamily = familyInfoResp.find((familyInfo) =>
        families.includes(familyInfo.remarkName)
      );
      if (tagetFamily) {
        familyId = tagetFamily.familyId;
      } else {
        logger.error(
          `没有加入到指定家庭分组${families
            .map((family) => mask(family, 3, 7))
            .toString()}`
        );
      }
    } else {
      familyId = familyInfoResp[0].familyId;
    }
    console.log(`执行家签ID:${familyId}`);
    const tasks = [ cloudClient.familyUserSign(familyId) ]
    const result = (await Promise.allSettled(tasks)).filter(
        ({ status, value })=> status ==='fulfilled' && !value.signStatus
        // ({ status, value }) => status === "fulfilled" && !value.signStatus && value.bonusSpace
        );
    return console.log(
      `家庭签到任务: 获得 ${
         result.map(({ value }) => value.bonusSpace)?.join(",") || "0"
       }M 空间`
    );
  }
};
const now = new Date();
const month = now.getMonth() + 1; // 月份从 0 开始，需 +1（11 表示 11 月）
const day = now.getDate(); // 15
const dayOfWeek = now.getDay();
const run = async (userName, password, userSizeInfoMap, logger,userNameInfo) => {
  if (userName && password) {
    const before = Date.now();
    try {
      logger.log('\n%s 签到任务',`${month}-${day}`)
      console.log('开始执行');
      const cloudClient = new CloudClient({
        username: userName, 
        password,
        token: new FileTokenStore(`${tokenDir}/${userName}.json`)
      });
      logger.log('%s',userNameInfo)
      const beforeUserSizeInfo = await cloudClient.getUserSizeInfo();
      userSizeInfoMap.set(userName, {
        cloudClient,
        userSizeInfo: beforeUserSizeInfo,
        logger,
      });
      // await Promise.all([
      //   doUserTask(cloudClient, logger),
      //   doFamilyTask(cloudClient, logger),
      // ]);
      const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
      const tasks = [
        () => doUserTask(cloudClient, logger),  // 包裹成函数
        // () => doFamilyTask(cloudClient, logger)
      ];
      
      for (const task of tasks) {
        const minDelay = 200;   // 2 秒
        const maxDelay = 300; // 30 秒
        const randomDelay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
        await delay(randomDelay); // 等待随机间隔
        await task(); // 执行当前任务
      }

    } catch (e) {
      if (e.response) {
        logger.log(`请求失败: ${e.response.statusCode}, ${e.response.body}`);
      } else {
        logger.error(e);
      }
      if (e.code === "ECONNRESET" || e.code === "ETIMEDOUT") {
        logger.error("请求超时");
        throw e;
      }
    } finally {
      console.log(
        `执行完毕, 耗时 ${((Date.now() - before) / 1000).toFixed(2)} 秒`
      );
    }
  }
};

// 开始执行程序
async function main() {
  if(!fs.existsSync(tokenDir)){
    fs.mkdirSync(tokenDir)
  }
  //  用于统计实际容量变化
  const userSizeInfoMap = new Map();
  for (let index = 0; index < accounts.length; index++) {
    const account = accounts[index];
    const { userName, password } = account;
    const userNameInfo = mask(userName, 3, 7);
    const logger = log4js.getLogger(userName);
    logger.addContext("user", userNameInfo);
    await run(userName, password, userSizeInfoMap, logger,userNameInfo);
  }

  //数据汇总
  for (const [userName, { cloudClient, userSizeInfo, logger } ] of userSizeInfoMap) {
    const afterUserSizeInfo = await cloudClient.getUserSizeInfo();
    logger.log(
      `个人容量：⬆️${(
        (afterUserSizeInfo.cloudCapacityInfo.totalSize -
          userSizeInfo.cloudCapacityInfo.totalSize) /
        1024 /
        1024
      ).toFixed(2)}M/${(
        afterUserSizeInfo.cloudCapacityInfo.totalSize /
        1024 /
        1024 /
        1024
      ).toFixed(2)}G/${(
        afterUserSizeInfo.cloudCapacityInfo.freeSize /
        1024 /
        1024 /
        1024
      ).toFixed(2)}G\n容量：⬆️${(
        (afterUserSizeInfo.cloudCapacityInfo.totalSize -
          userSizeInfo.cloudCapacityInfo.totalSize) /
        1024 /
        1024
      ).toFixed(2)}M/${(
        afterUserSizeInfo.cloudCapacityInfo.totalSize /
        1024 /
        1024 /
        1024
      ).toFixed(2)}G`
    //   \n家庭容量：⬆️${(
    //     (afterUserSizeInfo.familyCapacityInfo.totalSize -
    //       userSizeInfo.familyCapacityInfo.totalSize) /
    //     1024 /
    //     1024
    //   ).toFixed(2)}M/${(
    //     afterUserSizeInfo.familyCapacityInfo.totalSize /
    //     1024 /
    //     1024 /
    //     1024
    //   ).toFixed(2)}G`
    );
  }
}
const notify = require("./sendNotify");

(async () => {
  try {
    await main();
    //等待日志文件写入
    await delay(1000);
  } finally {
    const logs = catLogs();
    const events = recording.replay();
    const content = events.map((e) => `${e.data.join("")}`).join("  \n");

    // notify.sendNotify("天翼云盘自动签到任务",logs + content);
    if (dayOfWeek === 0) {
      console.log('今天是周日');
      fs.writeFileSync('user.txt', '', 'utf8');
    }
    try {
    console.log('即将写入的内容:', logs + content)
    fs.appendFileSync('user.txt', logs + content, 'utf8');
    console.log('文件追加成功');
    } catch (err) {
    console.error('写入文件时出错:', err);
    }
    if (dayOfWeek === 6) {
      console.log('今天是周六');
      const content = fs.readFileSync('user.txt', 'utf8'); // 指定编码（如 'utf8'）
      notify.sendNotify("天翼云盘自动签到任务",content);
    }
    // push("天翼云盘自动签到任务", logs + content);
    recording.erase();
    cleanLogs();
  }
})();
