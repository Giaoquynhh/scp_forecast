import {
  emptySummaryRow, toSummaryRow,
  type SummaryQuery, type SummaryReader, type SummaryResult,
} from '../domain/summary.js';

/**
 * Điều phối: gọi reader hai lượt rồi áp hàm thuần của domain lên số thô.
 *
 * Vì sao hai lượt thay vì cộng lại `rows` ở JS: skuCount/cnCount là đếm phân biệt.
 * Một SKU bán ở 5 CN thì cộng dồn ra 5, trong khi số đúng là 1. Postgres đếm lại
 * trên toàn tập rẻ hơn nhiều so với việc kéo cả tập khoá về client để hợp nhất.
 *
 * groupBy='none' chỉ chạy một lượt — `rows` rỗng thì lượt kia không có việc gì.
 */
export class SummaryService {
  constructor(private readonly reader: SummaryReader) {}

  async summarize(query: SummaryQuery): Promise<SummaryResult> {
    const [groups, totals] = await Promise.all([
      query.groupBy === 'none'
        ? Promise.resolve([])
        : this.reader.aggregate(query, query.groupBy),
      this.reader.aggregate(query, 'none'),
    ]);

    return {
      from: query.from,
      to: query.to,
      groupBy: query.groupBy,
      rounded: query.rounded,
      rows: groups.map(toSummaryRow),
      total: totals.length > 0 ? toSummaryRow(totals[0]) : emptySummaryRow(),
    };
  }
}
