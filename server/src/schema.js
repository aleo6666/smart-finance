export function getCreateTableStatements() {
  return [
    `CREATE TABLE IF NOT EXISTS users (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      mini_openid VARCHAR(128) UNIQUE,
      mp_openid VARCHAR(128) UNIQUE,
      unionid VARCHAR(128),
      phone VARCHAR(32),
      nickname VARCHAR(128),
      avatar TEXT,
      password VARCHAR(255),
      username VARCHAR(128) UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login_at DATETIME NULL,
      KEY idx_users_unionid (unionid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS ledgers (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT UNSIGNED NOT NULL,
      name VARCHAR(128) NOT NULL,
      base_currency VARCHAR(16) NOT NULL DEFAULT 'CNY',
      icon VARCHAR(64),
      color VARCHAR(32),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      KEY idx_ledgers_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS records (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      device_id VARCHAR(128) NOT NULL,
      user_id BIGINT UNSIGNED NULL,
      ledger_id BIGINT UNSIGNED NULL,
      type VARCHAR(16) NOT NULL DEFAULT 'expense',
      amount DECIMAL(14,4) NOT NULL,
      currency VARCHAR(16) NOT NULL DEFAULT 'CNY',
      amount_cny DECIMAL(14,4) NULL,
      category VARCHAR(64) NOT NULL,
      description TEXT,
      merchant VARCHAR(128),
      project VARCHAR(128),
      member VARCHAR(128),
      date DATE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      KEY idx_records_user_date (user_id, date),
      KEY idx_records_device_date (device_id, date),
      KEY idx_records_ledger_date (ledger_id, date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS record_attachments (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      record_id BIGINT UNSIGNED NOT NULL,
      file_path TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      KEY idx_record_attachments_record (record_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS budgets (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      device_id VARCHAR(128),
      user_id BIGINT UNSIGNED NULL,
      ledger_id BIGINT UNSIGNED NULL,
      category VARCHAR(64),
      amount DECIMAL(14,4) NOT NULL,
      period VARCHAR(32) NOT NULL DEFAULT 'monthly',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      KEY idx_budgets_user (user_id, ledger_id, category)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS goals (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      device_id VARCHAR(128),
      user_id BIGINT UNSIGNED NULL,
      ledger_id BIGINT UNSIGNED NULL,
      name VARCHAR(128) NOT NULL,
      target_amount DECIMAL(14,4) NOT NULL,
      current_amount DECIMAL(14,4) DEFAULT 0,
      deadline DATE NULL,
      completed TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      KEY idx_goals_user (user_id, ledger_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS reminders (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      device_id VARCHAR(128),
      user_id BIGINT UNSIGNED NULL,
      type VARCHAR(64) NOT NULL DEFAULT 'daily',
      title VARCHAR(255) NOT NULL,
      message TEXT,
      channel VARCHAR(32) NOT NULL DEFAULT 'inapp',
      status VARCHAR(32) NOT NULL DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      read_at DATETIME NULL,
      KEY idx_reminders_user_status (user_id, status),
      KEY idx_reminders_device_status (device_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS wechat_subscribe (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT UNSIGNED NOT NULL,
      openid VARCHAR(128) NOT NULL,
      template_id VARCHAR(128) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'authorized',
      authorized_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_wechat_subscribe_user_template (user_id, template_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS reports (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT UNSIGNED NOT NULL,
      ledger_id BIGINT UNSIGNED NULL,
      period_type VARCHAR(32) NOT NULL,
      period_value VARCHAR(32) NOT NULL,
      source VARCHAR(32) NOT NULL DEFAULT 'auto',
      summary_json JSON NULL,
      generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      KEY idx_reports_user_generated (user_id, generated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS report_shares (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      report_id BIGINT UNSIGNED NOT NULL,
      token VARCHAR(128) UNIQUE NOT NULL,
      expire_at DATETIME NULL,
      KEY idx_report_shares_report (report_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS report_templates (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT UNSIGNED NOT NULL,
      name VARCHAR(128) NOT NULL,
      config_json JSON NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      KEY idx_report_templates_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS exchange_rates (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      base VARCHAR(16) NOT NULL DEFAULT 'CNY',
      currency VARCHAR(16) NOT NULL,
      rate DECIMAL(18,8) NOT NULL,
      fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      KEY idx_exchange_rates_currency (currency, fetched_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS feedback (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      device_id VARCHAR(128),
      user_id BIGINT UNSIGNED NULL,
      type VARCHAR(32) NOT NULL DEFAULT 'suggestion',
      content TEXT NOT NULL,
      image_path TEXT,
      priority VARCHAR(16) DEFAULT 'P2',
      status VARCHAR(32) DEFAULT 'pending',
      admin_reply TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      KEY idx_feedback_user_status (user_id, status),
      KEY idx_feedback_device_status (device_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS devices (
      device_id VARCHAR(128) PRIMARY KEY,
      first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
      survey_sent TINYINT(1) NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS agent_tasks (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      task_id VARCHAR(64) NOT NULL UNIQUE,
      user_id BIGINT UNSIGNED NULL,
      agent_type VARCHAR(32) NOT NULL,
      intent VARCHAR(32) NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'queued',
      payload_json JSON NULL,
      result_json JSON NULL,
      error_message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME NULL,
      KEY idx_agent_tasks_user_created (user_id, created_at),
      KEY idx_agent_tasks_status (status, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS llm_calls (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT UNSIGNED NULL,
      conversation_id VARCHAR(64) NULL,
      provider VARCHAR(16) NOT NULL,
      model VARCHAR(64) NOT NULL,
      call_type VARCHAR(32) NOT NULL,
      input_tokens INT UNSIGNED DEFAULT 0,
      output_tokens INT UNSIGNED DEFAULT 0,
      latency_ms INT UNSIGNED NOT NULL DEFAULT 0,
      cost_usd DECIMAL(10,6) DEFAULT 0,
      success TINYINT(1) NOT NULL DEFAULT 1,
      error_message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      KEY idx_llm_calls_user_created (user_id, created_at),
      KEY idx_llm_calls_type_created (call_type, created_at),
      KEY idx_llm_calls_provider_created (provider, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS ocr_evaluations (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      record_id BIGINT UNSIGNED NULL,
      user_id BIGINT UNSIGNED NOT NULL,
      ocr_result JSON NOT NULL,
      user_confirmed TINYINT(1) DEFAULT 0,
      user_corrected TINYINT(1) DEFAULT 0,
      corrected_category VARCHAR(64) NULL,
      corrected_amount DECIMAL(14,4) NULL,
      ocr_correct TINYINT(1) NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      confirmed_at DATETIME NULL,
      KEY idx_ocr_evaluations_user_created (user_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS cost_alert_rules (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT UNSIGNED NULL,
      threshold_usd DECIMAL(10,4) NOT NULL DEFAULT 10.00,
      period_days INT UNSIGNED NOT NULL DEFAULT 1,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      KEY idx_cost_alert_rules_user (user_id, enabled)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  ]
}

export async function ensureSchema(db) {
  for (const statement of getCreateTableStatements()) {
    await db.raw(statement)
  }
}
