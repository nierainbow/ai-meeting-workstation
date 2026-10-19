export function defaultCustomerProfile(customerId: string): string {
  return [
    `# ${customerId || "新客户"} 公司档案`,
    "",
    "## 公司做什么",
    "待填写",
    "",
    "## 合伙人及分工",
    "待填写",
    "",
    "## 行业术语",
    "待填写",
    "",
    "## 长期目标",
    "待填写",
    ""
  ].join("\n");
}
