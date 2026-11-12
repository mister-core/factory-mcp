CREATE DATABASE IF NOT EXISTS mcp_selftest DEFAULT CHARSET utf8mb4;
USE mcp_selftest;
DROP TABLE IF EXISTS mcp_selftest_parts;
CREATE TABLE mcp_selftest_parts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  product_sn VARCHAR(64) NOT NULL COMMENT '总成码',
  part_sn    VARCHAR(64) COMMENT '零件码',
  workno     VARCHAR(32) COMMENT '工位编号',
  result     VARCHAR(8)  COMMENT '检验结果',
  torque     DECIMAL(8,3) COMMENT '拧紧扭矩 N·m',
  create_time DATETIME   COMMENT '入库时间'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='MCP 自检用表（假数据）';
INSERT INTO mcp_selftest_parts(product_sn,part_sn,workno,result,torque,create_time) VALUES
 ('ASM-1001','P-1001','WS-01','OK',32.150,'2026-09-30 08:01:02'),
 ('ASM-1001','P-1002','WS-01','OK',31.870,'2026-09-30 08:03:11'),
 ('ASM-1002','P-1003','WS-02','NO',28.400,'2026-09-30 09:15:40'),
 ('ASM-1002','P-1004','WS-02','OK',33.010,'2026-09-30 09:22:05');
SELECT COUNT(*) AS rows_seeded FROM mcp_selftest_parts;
